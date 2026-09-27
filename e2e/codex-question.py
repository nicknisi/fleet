#!/usr/bin/env python3
"""Exercise Fleet's answer mode with real Codex and a loopback response stub."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fleet-bin', type=Path, default=Path(__file__).resolve().parents[1] / 'dist/fleet')
parser.add_argument('--output-dir', type=Path)
parser.add_argument('--answer-mode', choices=['notes', 'digit'], default='notes')
args = parser.parse_args()
codex = shutil.which('codex')
if codex is None:
    parser.error('codex executable not found in PATH')
root = Path(tempfile.mkdtemp(prefix='fq-', dir=args.output_dir))
socket = root / 'tmux.sock'
requests = []
print('Artifacts:', root, flush=True)
questions = [
    {'id': 'colour', 'header': 'Colour', 'question': 'Which fixture colour should Fleet select?',
     'options': [{'label': 'Red', 'description': 'Use the red fixture.'},
                 {'label': 'Blue', 'description': 'Use the blue fixture.'}]},
    {'id': 'note', 'header': 'Note', 'question': 'What note should Fleet attach?',
     'options': [{'label': 'No note', 'description': 'Leave the note empty.'},
                 {'label': 'Add note', 'description': 'Attach a custom note.'}]}]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        data = b'{"object":"list","data":[]}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        requests.append({'path': self.path, 'body': body})
        number = len(requests)
        if number == 1:
            item = {'type': 'function_call', 'id': 'fc_question', 'call_id': 'call_question',
                    'name': 'request_user_input', 'arguments': json.dumps({'questions': questions}), 'status': 'completed'}
        else:
            item = {'type': 'message', 'id': f'msg_{number}', 'role': 'assistant', 'status': 'completed',
                    'content': [{'type': 'output_text', 'text': 'Local question check complete.', 'annotations': []}]}
        response = {'id': f'resp_{number}', 'object': 'response', 'created_at': int(time.time()),
                    'status': 'completed', 'output': [item],
                    'usage': {'input_tokens': 1000, 'output_tokens': 20, 'total_tokens': 1020,
                              'input_tokens_details': {'cached_tokens': 0},
                              'output_tokens_details': {'reasoning_tokens': 0}}}
        events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                  {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'status': 'in_progress'}},
                  {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                  {'type': 'response.completed', 'response': response}]
        data = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
codex_home = root / 'codex'
workspace = root / 'workspace'
config = root / 'config'
for directory in (codex_home, workspace, config / 'fleet'):
    directory.mkdir(parents=True)
(config / 'fleet/agents.json').write_text('{"agents":[]}')
(codex_home / 'config.toml').write_text(f'''
model = "gpt-6-astra"
model_reasoning_effort = "max"
model_provider = "fleet_question_test"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[features]
default_mode_request_user_input = true
[model_providers.fleet_question_test]
name = "Fleet question validation"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[projects."{workspace}"]
trust_level = "trusted"
''')


def tm(*arguments):
    return subprocess.check_output(['tmux', '-S', str(socket), '-f', '/dev/null', *arguments], text=True).strip()


def capture(target):
    return tm('capture-pane', '-p', '-t', target)


def wait_for(predicate, label, seconds=15):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(.05)
    raise AssertionError('Timed out: ' + label)


def save_screen(label):
    for target in ('codex', 'monitor'):
        try:
            (root / f'{label}-{target}.txt').write_text(capture(target))
        except subprocess.CalledProcessError:
            pass


def received_answers():
    for request in requests:
        for item in request['body'].get('input', []):
            if item.get('type') == 'function_call_output' and item.get('call_id') == 'call_question':
                try:
                    return json.loads(item['output']).get('answers')
                except (ValueError, TypeError):
                    continue
    return None


try:
    # The first visible composer can precede input readiness under load. Start
    # this question fixture with an argv prompt, so the initial Enter/paste
    # timing is not an unrelated failure before Fleet has even launched.
    command = ['env', 'CODEX_HOME=' + str(codex_home), 'TERM=xterm-256color', codex,
               '--no-alt-screen', '-C', str(workspace), 'Ask the fixture questions.']
    tm('new-session', '-d', '-s', 'codex', '-x', '120', '-y', '36', shlex.join(command))
    wait_for(lambda: 'enter to submit' in capture('codex'), 'native question', seconds=30)
    tmux_env = f'{socket},{tm("display-message", "-p", "#{pid}")},0'
    command = ['env', 'TMUX=' + tmux_env, 'TMPDIR=' + str(root), 'XDG_CONFIG_HOME=' + str(config),
               'FLEET_THEME=dark', str(args.fleet_bin.resolve())]
    tm('new-session', '-d', '-s', 'monitor', '-x', '140', '-y', '40', shlex.join(command))
    monitor_pid = tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}')
    wait_for(lambda: 'asking' in capture('monitor'), 'Fleet question discovery')
    tm('send-keys', '-t', 'monitor', 's')
    wait_for(lambda: '● ANSWER' in capture('monitor') and 'Which fixture colour' in capture('monitor'), 'S answer window')
    save_screen('open')
    assert 'Blue' in capture('monitor') and 'Red' in capture('monitor')
    tm('send-keys', '-t', 'monitor', 'Escape')
    wait_for(lambda: '● ANSWER' not in capture('monitor'), 'Escape back to Fleet')
    assert 'enter to submit' in capture('codex'), 'Fleet Escape dismissed the native question'
    assert tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}') == monitor_pid
    tm('send-keys', '-t', 'monitor', 's')
    wait_for(lambda: '● ANSWER' in capture('monitor'), 'reopen existing answer form')
    tm('send-keys', '-t', 'monitor', 'Down', 'Enter')
    wait_for(lambda: 'What note should Fleet attach?' in capture('monitor'), 'second question')
    assert '● ANSWER' in capture('monitor'), 'Fleet left before the remaining question was answered'
    save_screen('second')
    if args.answer_mode == 'digit':
        assert tm('display-message', '-p', '-t', 'codex', '#{cursor_flag}') == '0'
        tm('send-keys', '-t', 'monitor', '-l', '1FLEET_SUFFIX_PROBE')
        expected_note = ['No note']
    else:
        tm('send-keys', '-t', 'monitor', 'Down', 'Tab')
        wait_for(lambda: 'clear notes' in capture('codex'), 'native notes focus')
        assert tm('display-message', '-p', '-t', 'codex', '#{cursor_flag}') == '1'
        tm('send-keys', '-t', 'monitor', '-l', 'café 2026 fixture note')
        time.sleep(.3)
        tm('send-keys', '-t', 'monitor', '-l', '\rFLEET_SUFFIX_PROBE')
        expected_note = ['Add note', 'user_note: café 2026 fixture note']
    wait_for(lambda: received_answers() is not None, 'answers received by native Codex')
    assert received_answers() == {'colour': {'answers': ['Blue']},
                                  'note': {'answers': expected_note}}, received_answers()
    wait_for(lambda: '● ANSWER' not in capture('monitor') and '[↑↓] nav' in capture('monitor'),
             'automatic return to Fleet after the final answer')
    save_screen('answered')
    assert 'FLEET_SUFFIX_PROBE' not in capture('codex'), 'coalesced answer suffix reached the main composer'
    assert '● LIVE' not in capture('monitor'), 'Fleet entered the live conversation after answering'
    tm('send-keys', '-t', 'monitor', '-l', 'zzzzzz')
    time.sleep(.2)
    assert 'zzzzzz' not in capture('codex')
    assert tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}') == monitor_pid
    print(json.dumps({'pass': True, 'native_form_in_s_window': True, 'escape_preserved_question': True,
                      'choice_and_text_answers': True, 'no_new_prompt_after_answer': True,
                      'automatic_return_to_monitor': True, 'same_monitor_process': True}), flush=True)
finally:
    save_screen('last')
    (root / 'requests.json').write_text(json.dumps(requests, indent=2, ensure_ascii=False))
    subprocess.run(['tmux', '-S', str(socket), 'kill-server'], capture_output=True)
    server.shutdown()

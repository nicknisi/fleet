#!/usr/bin/env python3
"""Exercise Fleet's question mode with real Claude Code and a loopback API stub."""
import argparse
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fleet-bin', type=Path, default=Path(__file__).resolve().parents[1] / 'dist/fleet')
parser.add_argument('--output-dir', type=Path)
args = parser.parse_args()
claude = shutil.which('claude')
if claude is None:
    parser.error('claude executable not found in PATH')
root = Path(tempfile.mkdtemp(prefix='cq-', dir=args.output_dir))
socket = root / 'tmux.sock'
requests = []
print('Artifacts:', root, flush=True)
QUESTION_ID = 'toolu_fleet_question'
BASH_ID = 'toolu_fleet_bash'
questions = [
    {'header': 'Colour', 'question': 'Which fixture colour should Fleet select?', 'multiSelect': False,
     'options': [{'label': 'Red', 'description': 'Use the red fixture.'},
                 {'label': 'Blue', 'description': 'Use the blue fixture.'}]},
    {'header': 'Note', 'question': 'What note should Fleet attach?', 'multiSelect': False,
     'options': [{'label': 'No note', 'description': 'Leave the note empty.'},
                 {'label': 'Short note', 'description': 'Attach a short note.'}]}]
USAGE = {'input_tokens': 100, 'cache_creation_input_tokens': 200, 'cache_read_input_tokens': 700}


def tool_result(body, tool_id):
    for message in body.get('messages', []):
        content = message.get('content')
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get('tool_use_id') == tool_id:
                return block.get('content')
    return None


def received(tool_id):
    for request in list(requests):
        result = tool_result(request['body'], tool_id)
        if result is not None:
            return result
    return None


def last_user_text(body):
    """Text of the latest user turn; Claude may append reminder messages after the prompt."""
    texts = []
    for message in reversed(body.get('messages') or []):
        if message.get('role') == 'assistant':
            break
        content = message.get('content')
        if isinstance(content, str):
            texts.append(content)
        else:
            texts.extend(block.get('text', '') for block in content or [] if isinstance(block, dict))
    return ' '.join(texts)


def next_block(body):
    """The main loop offers AskUserQuestion; side requests (titles etc.) do not."""
    if not any(isinstance(tool, dict) and tool.get('name') == 'AskUserQuestion' for tool in body.get('tools') or []):
        return {'type': 'text', 'text': 'ok'}
    if 'fixture directory' in last_user_text(body):
        return {'type': 'tool_use', 'id': BASH_ID, 'name': 'Bash',
                'input': {'command': 'mkdir fleet-fixture-dir', 'description': 'Create a fixture directory'}}
    if tool_result(body, QUESTION_ID) is None:
        return {'type': 'tool_use', 'id': QUESTION_ID, 'name': 'AskUserQuestion', 'input': {'questions': questions}}
    return {'type': 'text', 'text': 'Local question check complete.'}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, kind='application/json'):
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(b'{"data":[],"has_more":false}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        requests.append({'path': self.path, 'body': body})
        if 'count_tokens' in self.path:
            return self.reply(b'{"input_tokens":100}')
        block = next_block(body)
        usage = USAGE
        stop = 'tool_use' if block['type'] == 'tool_use' else 'end_turn'
        message = {'id': f'msg_fixture_{len(requests)}', 'type': 'message', 'role': 'assistant',
                   'model': body.get('model', 'claude-fixture'), 'content': [], 'stop_reason': None,
                   'stop_sequence': None, 'usage': {**usage, 'output_tokens': 1}}
        if not body.get('stream'):
            return self.reply(json.dumps({**message, 'content': [block], 'stop_reason': stop,
                                          'usage': {**usage, 'output_tokens': 20}}).encode())
        if block['type'] == 'tool_use':
            start = {**block, 'input': {}}
            delta = {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])}
        else:
            start = {'type': 'text', 'text': ''}
            delta = {'type': 'text_delta', 'text': block['text']}
        events = [('message_start', {'type': 'message_start', 'message': message}),
                  ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': start}),
                  ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': delta}),
                  ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                  ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None},
                                     'usage': {'output_tokens': 20}}),
                  ('message_stop', {'type': 'message_stop'})]
        self.reply(''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events).encode(),
                   'text/event-stream')


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
claude_config = root / 'claude'
workspace = root / 'workspace'
config = root / 'config'
for directory in (claude_config, workspace, config / 'fleet'):
    directory.mkdir(parents=True)
(config / 'fleet/agents.json').write_text('{"agents":[]}')
# A private config directory keeps z's hooks, trust list and transcripts out of
# the fixture. Pre-accept onboarding and workspace trust for this directory only.
(claude_config / '.claude.json').write_text(json.dumps({
    'hasCompletedOnboarding': True, 'theme': 'dark', 'autoUpdates': False,
    'projects': {str(workspace): {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True,
                                  'allowedTools': []}}}))


def tm(*arguments):
    return subprocess.check_output(['tmux', '-f', '/dev/null', '-S', str(socket), *arguments], text=True).strip()


def capture(target):
    return tm('capture-pane', '-p', '-t', target)


def wait_for(predicate, label, seconds=20):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(.05)
    raise AssertionError('Timed out: ' + label)


def save_screen(label):
    for target in ('claude', 'monitor'):
        try:
            (root / f'{label}-{target}.txt').write_text(capture(target))
        except subprocess.CalledProcessError:
            pass


try:
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(('CLAUDE', 'ANTHROPIC')) and key != 'TMUX'}
    environment.update({
        'CLAUDE_CONFIG_DIR': str(claude_config), 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}',
        'ANTHROPIC_AUTH_TOKEN': 'fleet-fixture', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
        # Otherwise a fresh config directory clones the official plugin marketplace.
        'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL': '1',
        'DISABLE_AUTOUPDATER': '1', 'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
        'XDG_STATE_HOME': str(root / 'state'),
        'TERM': 'xterm-256color'})
    # This fixture must see a real permission prompt. Claude 2.1.283 defaults
    # to auto mode, which can execute its harmless mkdir without asking.
    command = ['env', '-i', *(f'{k}={v}' for k, v in environment.items()),
               claude, '--permission-mode', 'default']
    tm('new-session', '-d', '-s', 'claude', '-x', '120', '-y', '36', '-c', str(workspace), shlex.join(command))
    wait_for(lambda: '❯' in capture('claude'), 'Claude prompt')
    time.sleep(1)
    tm('send-keys', '-t', 'claude', '-l', 'Ask the fixture questions.')
    time.sleep(.3)
    tm('send-keys', '-t', 'claude', 'Enter')
    wait_for(lambda: 'Which fixture colour' in capture('claude'), 'native Claude question')
    tmux_env = f'{socket},{tm("display-message", "-p", "#{pid}")},0'
    command = ['env', 'TMUX=' + tmux_env, 'TMPDIR=' + str(root), 'XDG_CONFIG_HOME=' + str(config),
               'XDG_STATE_HOME=' + str(root / 'state'),
               'FLEET_THEME=dark', str(args.fleet_bin.resolve())]
    tm('new-session', '-d', '-s', 'monitor', '-x', '140', '-y', '40', shlex.join(command))
    monitor_pid = tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}')
    wait_for(lambda: 'asking' in capture('monitor'), 'Fleet question discovery')
    tm('send-keys', '-t', 'monitor', 's')
    wait_for(lambda: '● ANSWER' in capture('monitor') and 'Which fixture colour' in capture('monitor'), 'S answer window')
    save_screen('open')
    assert 'Blue' in capture('monitor') and '[Esc]' in capture('monitor')
    tm('send-keys', '-t', 'monitor', 'Escape')
    wait_for(lambda: '● ANSWER' not in capture('monitor'), 'Escape back to Fleet')
    assert 'Which fixture colour' in capture('claude'), 'Fleet Escape dismissed the native question'
    assert tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}') == monitor_pid
    tm('send-keys', '-t', 'monitor', 's')
    wait_for(lambda: '● ANSWER' in capture('monitor'), 'reopen existing answer form')
    tm('send-keys', '-t', 'monitor', 'Down')
    time.sleep(.3)
    tm('send-keys', '-t', 'monitor', 'Enter')
    wait_for(lambda: 'What note should Fleet attach?' in capture('monitor'), 'second question')
    save_screen('second')
    tm('send-keys', '-t', 'monitor', 'Down')
    time.sleep(.2)
    tm('send-keys', '-t', 'monitor', 'Down')
    time.sleep(.3)
    tm('send-keys', '-t', 'monitor', '-l', 'café fixture note')
    wait_for(lambda: 'café fixture note' in capture('monitor'), 'typed answer visible in Fleet')
    tm('send-keys', '-t', 'monitor', 'Enter')
    wait_for(lambda: 'Ready to submit your answers?' in capture('monitor'), 'review page inside Fleet')
    assert '● ANSWER' in capture('monitor'), 'Fleet left before the answers were submitted'
    save_screen('review')
    tm('send-keys', '-t', 'monitor', '-l', '\rFLEET_SUFFIX_PROBE')
    wait_for(lambda: received(QUESTION_ID) is not None, 'answers received through native Claude')
    answer = str(received(QUESTION_ID))
    assert '"Which fixture colour should Fleet select?"="Blue"' in answer, answer
    assert '"What note should Fleet attach?"="café fixture note"' in answer, answer
    wait_for(lambda: '● ANSWER' not in capture('monitor') and '[↑↓] nav' in capture('monitor'),
             'automatic return to Fleet after the final answer')
    save_screen('answered')
    assert 'FLEET_SUFFIX_PROBE' not in capture('claude'), 'coalesced answer suffix reached the main composer'
    tm('send-keys', '-t', 'monitor', '-l', 'zzzzzz')
    time.sleep(.3)
    assert 'zzzzzz' not in capture('claude'), 'typing after the answer reached Claude'
    # A real permission prompt must never be answered through the question window.
    tm('send-keys', '-t', 'claude', '-l', 'Make the fixture directory.')
    time.sleep(.3)
    tm('send-keys', '-t', 'claude', 'Enter')
    wait_for(lambda: 'Do you want to proceed?' in capture('claude'), 'native Claude permission prompt')
    # The legend always says "waiting"; wait for the agent row's own permit marker.
    wait_for(lambda: re.search(r'(?m)^\S?\s*⚠ claude', capture('monitor')) is not None, 'Fleet permission status')
    tm('send-keys', '-t', 'monitor', 's')
    wait_for(lambda: 'Agent has a permission prompt' in capture('monitor'), 'blocked send view for a permission prompt')
    time.sleep(1)
    assert '● ANSWER' not in capture('monitor'), 'Fleet opened a permission prompt as a question'
    save_screen('permission')
    tm('send-keys', '-t', 'monitor', 'Escape')
    time.sleep(.5)
    assert 'Do you want to proceed?' in capture('claude'), 'the permission prompt changed'
    assert received(BASH_ID) is None and not (workspace / 'fleet-fixture-dir').exists()
    assert tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}') == monitor_pid
    print(json.dumps({'pass': True, 'native_form_in_s_window': True, 'escape_preserved_question': True,
                      'choice_typed_and_review_answers': True, 'no_new_prompt_after_answer': True,
                      'automatic_return_to_monitor': True,
                      'permission_prompt_never_answered': True, 'same_monitor_process': True}), flush=True)
finally:
    save_screen('last')
    (root / 'requests.json').write_text(json.dumps(requests, indent=2, ensure_ascii=False))
    subprocess.run(['tmux', '-S', str(socket), 'kill-server'], capture_output=True)
    server.shutdown()

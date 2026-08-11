// FleetNotifier.app helper: posts native macOS notifications through
// UNUserNotificationCenter and runs the click command when the body is
// clicked. Must run from inside the installed, ad-hoc signed FleetNotifier.app
// bundle (see scripts/install-notifier.sh); macOS 26 grants notification
// permission only to apps in registered locations, so the helper lives at
// ~/Applications/FleetNotifier.app.
//
// usage: fleet-notifier [--spawned] <title> <body> [click-command]
//        fleet-notifier --setup
//
// Without --spawned it re-executes itself detached and returns immediately, so
// the caller never blocks on the click window. The spawned instance keeps the
// main run loop alive until the notification is clicked, dismissed, or the
// click window elapses, then removes the delivered notification and exits.
//
// Denied permission is authoritative: an installed helper that the user has
// denied exits without posting — denial means silence, never a fallback. An
// undetermined status still spawns so the first delivery can prompt.
//
// --setup is the install-time flow: it requests permission, waits for the
// user's answer to the prompt, and posts a test notification when granted;
// exit 0 = granted, non-zero = denied/unavailable.

import Cocoa
import UserNotifications

// Bounded lifetime for the click wait. A stale helper holding a notification
// open is worse than a missed click; a few hours covers any reasonable away
// period. After it elapses the notification is closed and later clicks are
// no-ops.
private let clickWindow: TimeInterval = 6 * 60 * 60

private struct Parsed {
    let spawned: Bool
    let title: String
    let body: String
    let clickCommand: String?
}

private func parse(_ args: [String]) -> Parsed? {
    var rest = args
    var spawned = false
    if let first = rest.first, first == "--spawned" {
        spawned = true
        rest.removeFirst()
    }
    guard rest.count == 2 || rest.count == 3 else { return nil }
    return Parsed(
        spawned: spawned,
        title: rest[0],
        body: rest[1],
        clickCommand: rest.count == 3 ? rest[2] : nil
    )
}

// Synchronous wrapper around getNotificationSettings — the completion handler
// fires on an internal queue, so a semaphore is safe here (the main run loop
// is not yet running in the detach path).
private func authorizationStatus() -> UNAuthorizationStatus? {
    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var status: UNAuthorizationStatus?
    center.getNotificationSettings { settings in
        status = settings.authorizationStatus
        sem.signal()
    }
    if sem.wait(timeout: .now() + 10) == .timedOut { return nil }
    return status
}

// Request authorization, waiting for the user's answer to the system prompt.
private func requestAuthorization() -> Bool {
    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
        granted = ok
        sem.signal()
    }
    if sem.wait(timeout: .now() + 60) == .timedOut { return false }
    return granted
}

// Re-execute this binary detached with --spawned so the caller returns at
// once. Denied permission means silence: report failure and spawn nothing.
private func detach(_ parsed: Parsed) -> Int32 {
    if let status = authorizationStatus(), status == .denied {
        return 4
    }
    guard let exe = Bundle.main.executableURL else { return 1 }
    let proc = Process()
    proc.executableURL = exe
    var arguments = ["--spawned", parsed.title, parsed.body]
    if let click = parsed.clickCommand { arguments.append(click) }
    proc.arguments = arguments
    // Detach with stdio tied to /dev/null so the helper never writes back to
    // the caller's stdout/stderr (it is background-only and normally silent).
    let null = FileHandle(forUpdatingAtPath: "/dev/null")
    proc.standardInput = null
    proc.standardOutput = null
    proc.standardError = null
    do {
        try proc.run()
        return 0
    } catch {
        return 1
    }
}

// Delegate capturing the first user response to the posted notification. The
// default action is a body click; anything else (dismiss, timeout) is treated
// as a non-click.
private final class ResponseDelegate: NSObject, UNUserNotificationCenterDelegate {
    var clicked = false
    var resolved = false

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The helper is background-only (LSUIElement), but present the banner
        // regardless so a re-entry while still alive still shows it.
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            clicked = true
        }
        resolved = true
        completionHandler()
    }
}

// Run the click command via /bin/sh -c. Returns 0 on success, 6 on failure.
private func runClick(_ command: String) -> Int32 {
    let proc = Process()
    proc.launchPath = "/bin/sh"
    proc.arguments = ["-c", command]
    do {
        try proc.run()
        proc.waitUntilExit()
        return proc.terminationStatus == 0 ? 0 : 6
    } catch {
        return 6
    }
}

// Spawned path: the bundle owns the permission, so check + request, post, and
// keep the main run loop alive awaiting the body click.
private func runSpawned(_ parsed: Parsed) -> Int32 {
    switch authorizationStatus() {
    case .denied: return 4
    case .none: return 5
    default: break
    }
    if !requestAuthorization() { return 4 }

    let center = UNUserNotificationCenter.current()
    let delegate = ResponseDelegate()
    center.delegate = delegate

    let content = UNMutableNotificationContent()
    content.title = parsed.title
    content.body = parsed.body
    content.sound = .default

    let identifier = "fleet-notifier-\(Int(Date().timeIntervalSince1970))"
    let request = UNNotificationRequest(
        identifier: identifier,
        content: content,
        trigger: nil
    )

    var posted = false
    let postSem = DispatchSemaphore(value: 0)
    center.add(request) { error in
        posted = (error == nil)
        postSem.signal()
    }
    if postSem.wait(timeout: .now() + 10) == .timedOut { return 5 }
    if !posted { return 5 }

    // Run the main run loop in short slices so the delegate callback (delivered
    // on the main loop) can flip `resolved`. Bounded by the click window.
    let deadline = Date(timeIntervalSinceNow: clickWindow)
    while !delegate.resolved && Date() < deadline {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
    }

    center.removeDeliveredNotifications(withIdentifiers: [identifier])

    if delegate.clicked, let click = parsed.clickCommand {
        return runClick(click)
    }
    return 0
}

// --setup: request permission interactively and report the result. exit 0 =
// granted (and a test notification posted), non-zero = denied/unavailable.
private func runSetup() -> Int32 {
    switch authorizationStatus() {
    case .denied: return 4
    case .none: return 5
    default: break
    }
    if !requestAuthorization() { return 4 }

    let center = UNUserNotificationCenter.current()
    let content = UNMutableNotificationContent()
    content.title = "Fleet"
    content.body = "Notifications are ready."
    content.sound = .default
    let request = UNNotificationRequest(
        identifier: "fleet-notifier-setup",
        content: content,
        trigger: nil
    )
    var posted = false
    let sem = DispatchSemaphore(value: 0)
    center.add(request) { error in
        posted = (error == nil)
        sem.signal()
    }
    if sem.wait(timeout: .now() + 10) == .timedOut { return 5 }
    return posted ? 0 : 5
}

let arguments = CommandLine.arguments.dropFirst().map { String($0) }

if arguments == ["--setup"] {
    exit(runSetup())
}

guard let parsed = parse(arguments) else {
    FileHandle.standardError.write(
        Data("usage: fleet-notifier [--spawned] <title> <body> [click-command]\n".utf8)
    )
    exit(2)
}

if parsed.spawned {
    exit(runSpawned(parsed))
} else {
    exit(detach(parsed))
}

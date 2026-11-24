import CoreGraphics
import CryptoKit
import Darwin
// File-keychain APIs are deprecated by Apple but required for the existing local signing vault.
// Keep all password handling here; Bun and subprocess arguments never receive the password.
import Foundation
import Security

private let helperIdentifier = "com.boa.local-signing"
private let service = "creds:local-app-signing/local/keychain-password"
private var interrupted: Int32 = 0
private let fm = FileManager.default

private struct Failure: Error {
  let code: String
  let status: OSStatus?
  init(_ code: String, _ status: OSStatus? = nil) {
    self.code = code
    self.status = status
  }
}

private func checked(_ status: OSStatus, _ code: String) throws {
  if status != errSecSuccess { throw Failure(code, status) }
}

private func emit(_ value: [String: Any]) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
}

private func fingerprint(_ certificate: SecCertificate) -> String {
  Insecure.SHA1.hash(data: SecCertificateCopyData(certificate) as Data)
    .map { String(format: "%02X", $0) }.joined()
}

private func privateFile(_ path: String) throws {
  var st = stat()
  guard lstat(path, &st) == 0, st.st_uid == getuid(),
    st.st_mode & S_IFMT == S_IFREG, st.st_mode & 0o022 == 0
  else {
    throw Failure("UNSAFE_LOCAL_FILE")
  }
}

private struct Config: Codable {
  let version: Int
  let identity: String
  let keychainPath: String
  let credentialEntry: String
  let helperPath: String
  let helperSHA256: String
  let sourceSHA256: String
  var enabled: Bool

  static func read(_ path: String) throws -> Config {
    try privateFile(path)
    let value = try JSONDecoder().decode(
      Config.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    guard value.version == 2,
      value.identity.range(of: "^[A-F0-9]{40}$", options: .regularExpression) != nil,
      value.credentialEntry == "local-app-signing/local/keychain-password",
      value.keychainPath.hasPrefix("/"), value.helperPath.hasPrefix("/"),
      value.helperSHA256.count == 64
    else { throw Failure("INVALID_PROFILE") }
    try privateFile(value.keychainPath)
    return value
  }
}

private func keychain(_ path: String) throws -> SecKeychain {
  var ref: SecKeychain?
  try checked(SecKeychainOpen(path, &ref), "KEYCHAIN_OPEN_FAILED")
  guard let result = ref else { throw Failure("KEYCHAIN_OPEN_FAILED") }
  return result
}

private func unlocked(_ keychain: SecKeychain) throws -> Bool {
  var bits: SecKeychainStatus = 0
  try checked(SecKeychainGetStatus(keychain, &bits), "KEYCHAIN_STATUS_FAILED")
  return bits & kSecUnlockStateStatus != 0
}

private func closeKeychain(_ ref: SecKeychain) throws {
  try checked(SecKeychainLock(ref), "KEYCHAIN_RELOCK_FAILED")
  guard try !unlocked(ref) else { throw Failure("KEYCHAIN_RELOCK_FAILED") }
}

private func unlock(_ ref: SecKeychain, _ password: inout Data) throws {
  let result = password.withUnsafeBytes { bytes in
    SecKeychainUnlock(ref, UInt32(bytes.count), bytes.baseAddress, true)
  }
  try checked(result, "KEYCHAIN_UNLOCK_FAILED")
  guard try unlocked(ref) else { throw Failure("KEYCHAIN_UNLOCK_FAILED") }
}

private func wipe(_ data: inout Data) {
  data.resetBytes(in: 0..<data.count)
  data.removeAll()
}

private func ttyPassword() throws -> Data {
  let fd = open("/dev/tty", O_RDWR | O_CLOEXEC)
  guard fd >= 0 else { throw Failure("INTERACTIVE_TERMINAL_REQUIRED") }
  defer { close(fd) }
  var saved = termios()
  guard tcgetattr(fd, &saved) == 0 else { throw Failure("TTY_SETUP_FAILED") }
  var hidden = saved
  hidden.c_lflag &= ~tcflag_t(ECHO)
  guard tcsetattr(fd, TCSAFLUSH, &hidden) == 0 else { throw Failure("TTY_SETUP_FAILED") }
  defer {
    _ = tcsetattr(fd, TCSAFLUSH, &saved)
    _ = Darwin.write(fd, "\n", 1)
  }
  let prompt = "Mot de passe du trousseau de signature (saisie masquée) : "
  _ = prompt.withCString { Darwin.write(fd, $0, strlen($0)) }
  var data = Data()
  var byte: UInt8 = 0
  while read(fd, &byte, 1) == 1 {
    if byte == 10 || byte == 13 { break }
    guard data.count < 4096 else {
      wipe(&data)
      throw Failure("PASSWORD_TOO_LONG")
    }
    data.append(byte)
  }
  guard !data.isEmpty, interrupted == 0 else {
    wipe(&data)
    throw Failure("PASSWORD_REQUIRED")
  }
  return data
}

private func loginKeychain() throws -> SecKeychain {
  let path = fm.homeDirectoryForCurrentUser.appendingPathComponent(
    "Library/Keychains/login.keychain-db"
  ).path
  let ref = try keychain(path)
  guard try unlocked(ref) else { throw Failure("LOGIN_KEYCHAIN_LOCKED") }
  return ref
}

private func credentialQuery(_ login: SecKeychain) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service, kSecAttrAccount as String: NSUserName(),
    kSecMatchSearchList as String: [login], kSecMatchLimit as String: kSecMatchLimitOne,
  ]
}

private func boundedCredentialLookup<T>(limit: Double = 5, _ body: () throws -> T) throws -> T {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + limit)
  timer.setEventHandler {
    let message = "CREDENTIAL_LOOKUP_TIMEOUT\n"
    _ = message.withCString { Darwin.write(STDERR_FILENO, $0, strlen($0)) }
    // Outside a vault session no keychain has been opened; inside one the independent watchdog recovers.
    _exit(1)
  }
  timer.resume()
  defer { timer.cancel() }
  return try body()
}

private func passwordFromLogin() throws -> Data {
  return try boundedCredentialLookup {
    var query = credentialQuery(try loginKeychain())
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    try checked(SecItemCopyMatching(query as CFDictionary, &result), "CREDENTIAL_UNAVAILABLE")
    guard let data = result as? Data, !data.isEmpty else { throw Failure("CREDENTIAL_UNAVAILABLE") }
    return data
  }
}

private func signingInfo(_ path: String) throws -> [String: Any] {
  var code: SecStaticCode?
  try checked(
    SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code), "CODE_INVALID")
  guard let code = code else { throw Failure("CODE_INVALID") }
  try checked(
    SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil),
    "CODE_INVALID")
  var info: CFDictionary?
  try checked(
    SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info),
    "CODE_INFO_FAILED")
  guard let result = info as? [String: Any] else { throw Failure("CODE_INFO_FAILED") }
  return result
}

private func verifySigner(_ path: String, _ expected: String, identifier: String? = nil) throws {
  let info = try signingInfo(path)
  guard let certificates = info[kSecCodeInfoCertificates as String] as? [SecCertificate],
    let leaf = certificates.first, fingerprint(leaf) == expected
  else { throw Failure("SIGNER_MISMATCH") }
  if let identifier = identifier, info[kSecCodeInfoIdentifier as String] as? String != identifier {
    throw Failure("SIGNING_IDENTIFIER_MISMATCH")
  }
}

private func verifySelf(_ config: Config) throws {
  #if BOA_SIGNING_TESTS
    // Compiled out of the production helper. Only test-owned temporary keychains can exercise recovery without a real certificate.
    if config.identity == String(repeating: "0", count: 40) {
      try testPath(config.keychainPath)
      return
    }
  #endif
  let path = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
  guard path == config.helperPath else { throw Failure("HELPER_PATH_MISMATCH") }
  try privateFile(path)
  let hash = SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: path))).map {
    String(format: "%02x", $0)
  }.joined()
  guard hash == config.helperSHA256 else { throw Failure("HELPER_CHANGED") }
  try verifySigner(path, config.identity, identifier: helperIdentifier)
}

private func identity(_ ref: SecKeychain, _ expected: String) throws -> SecIdentity {
  let query: [String: Any] = [
    kSecClass as String: kSecClassIdentity,
    kSecMatchSearchList as String: [ref], kSecReturnRef as String: true,
    kSecMatchLimit as String: kSecMatchLimitAll,
  ]
  var result: CFTypeRef?
  try checked(SecItemCopyMatching(query as CFDictionary, &result), "IDENTITY_UNAVAILABLE")
  guard let identities = result as? [SecIdentity] else { throw Failure("IDENTITY_UNAVAILABLE") }
  let matches = identities.filter { item in
    var certificate: SecCertificate?
    return SecIdentityCopyCertificate(item, &certificate) == 0
      && certificate.map { fingerprint($0) == expected } == true
  }
  guard matches.count == 1 else { throw Failure("IDENTITY_NOT_UNIQUE") }
  var certificate: SecCertificate?
  try checked(SecIdentityCopyCertificate(matches[0], &certificate), "CERTIFICATE_UNAVAILABLE")
  guard let certificate = certificate,
    let policy = SecPolicyCreateWithProperties(kSecPolicyAppleCodeSigning, nil)
  else { throw Failure("CERTIFICATE_POLICY_FAILED") }
  var trust: SecTrust?
  try checked(
    SecTrustCreateWithCertificates(certificate, policy, &trust), "CERTIFICATE_TRUST_FAILED")
  guard let trust = trust else { throw Failure("CERTIFICATE_TRUST_FAILED") }
  try checked(SecTrustSetNetworkFetchAllowed(trust, false), "CERTIFICATE_TRUST_FAILED")
  guard SecTrustEvaluateWithError(trust, nil) else {
    throw Failure("CERTIFICATE_EXPIRED_OR_UNTRUSTED")
  }
  return matches[0]
}

private func trustedData(_ app: SecTrustedApplication) throws -> Data {
  var data: CFData?
  try checked(SecTrustedApplicationCopyData(app, &data), "SIGNING_ACCESS_UNVERIFIED")
  guard let data = data else { throw Failure("SIGNING_ACCESS_UNVERIFIED") }
  return data as Data
}

// Only the exact key associated with the configured certificate is inspected. Never rewrite partition ACLs here.
private func checkSigningAccess(_ identity: SecIdentity) throws {
  var key: SecKey?
  try checked(SecIdentityCopyPrivateKey(identity, &key), "PRIVATE_KEY_UNAVAILABLE")
  guard let key = key else { throw Failure("PRIVATE_KEY_UNAVAILABLE") }
  // File-keychain SecKey references also implement SecKeychainItem (legacy Security.framework contract).
  var access: SecAccess?
  try checked(
    SecKeychainItemCopyAccess(unsafeBitCast(key, to: SecKeychainItem.self), &access),
    "SIGNING_ACCESS_UNVERIFIED")
  guard let access = access else { throw Failure("SIGNING_ACCESS_UNVERIFIED") }
  try inspectAccess(access)
}

private func inspectAccess(_ access: SecAccess) throws {
  var code: SecStaticCode?
  var requirement: SecRequirement?
  try checked(
    SecRequirementCreateWithString(
      "anchor apple and identifier \"com.apple.security.codesign\"" as CFString, [], &requirement),
    "CODESIGN_IDENTITY_UNVERIFIED")
  try checked(
    SecStaticCodeCreateWithPath(URL(fileURLWithPath: "/usr/bin/codesign") as CFURL, [], &code),
    "CODESIGN_IDENTITY_UNVERIFIED")
  guard let code = code, let requirement = requirement else {
    throw Failure("CODESIGN_IDENTITY_UNVERIFIED")
  }
  try checked(SecStaticCodeCheckValidity(code, [], requirement), "CODESIGN_IDENTITY_UNVERIFIED")
  var trusted: SecTrustedApplication?
  try checked(
    SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &trusted), "SIGNING_ACCESS_UNVERIFIED")
  guard let trusted = trusted else { throw Failure("SIGNING_ACCESS_UNVERIFIED") }
  let expected = try trustedData(trusted)
  let acls = SecAccessCopyMatchingACLList(access, kSecACLAuthorizationSign) as? [SecACL] ?? []
  var allowed = false
  for acl in acls {
    var apps: CFArray?
    var description: CFString?
    var prompt = SecKeychainPromptSelector()
    try checked(SecACLCopyContents(acl, &apps, &description, &prompt), "SIGNING_ACCESS_UNVERIFIED")
    if prompt.contains(.requirePassphase) { continue }
    guard apps != nil else { throw Failure("BROAD_SIGNING_ACCESS") }
    // A nil application list grants all applications access; do not accept that broad configuration.
    for app in apps as? [SecTrustedApplication] ?? [] {
      if try trustedData(app) == expected { allowed = true }
    }
  }
  guard allowed else { throw Failure("CODESIGN_ACCESS_NOT_PROVISIONED") }
  let partitions =
    SecAccessCopyMatchingACLList(access, kSecACLAuthorizationPartitionID) as? [SecACL] ?? []
  guard !partitions.isEmpty else { throw Failure("PARTITION_ACCESS_UNVERIFIED") }
  for acl in partitions {
    var apps: CFArray?
    var text: CFString?
    var prompt = SecKeychainPromptSelector()
    try checked(SecACLCopyContents(acl, &apps, &text, &prompt), "PARTITION_ACCESS_UNVERIFIED")
    guard let text = text, let data = partitionData(text as String),
      let dict = try PropertyListSerialization.propertyList(from: data, format: nil)
        as? [String: Any],
      let values = dict["Partitions"] as? [String], values.contains("apple:")
    else {
      throw Failure("PARTITION_ACCESS_UNVERIFIED")
    }
  }
}

private func partitionData(_ text: String) -> Data? {
  guard text.utf8.count <= 65_536 else { return nil }
  if text.hasPrefix("<") { return text.data(using: .utf8) }
  guard text.count % 2 == 0, text.range(of: "^[a-fA-F0-9]+$", options: .regularExpression) != nil
  else { return nil }
  var data = Data()
  var index = text.startIndex
  while index != text.endIndex {
    let next = text.index(index, offsetBy: 2)
    guard let byte = UInt8(text[index..<next], radix: 16) else { return nil }
    data.append(byte)
    index = next
  }
  return data
}

private func run(
  _ program: String, _ args: [String], limit: TimeInterval = 20, onStart: ((pid_t) -> Void)? = nil
) throws {
  var actions: posix_spawn_file_actions_t?
  posix_spawn_file_actions_init(&actions)
  defer { posix_spawn_file_actions_destroy(&actions) }
  for descriptor: Int32 in [0, 1, 2] {
    guard
      posix_spawn_file_actions_addopen(
        &actions, descriptor, "/dev/null", descriptor == 0 ? O_RDONLY : O_WRONLY, 0) == 0
    else {
      throw Failure("SIGNING_COMMAND_START_FAILED")
    }
  }
  let strings = ([program] + args).map { strdup($0) }
  let environmentValues: [String] = [
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    "HOME=\(fm.homeDirectoryForCurrentUser.path)",
    "TMPDIR=\(NSTemporaryDirectory())",
  ]
  let environment = environmentValues.map { strdup($0) }
  defer {
    for pointer in strings { free(pointer) }
    for pointer in environment { free(pointer) }
  }
  var argv = strings + [nil]
  var env = environment + [nil]
  var child: pid_t = 0
  // Unlike Foundation.Process, posix_spawn without SETPGROUP inherits our group. The watchdog can
  // therefore terminate every owned signer/descendant before it re-locks the vault.
  guard posix_spawn(&child, program, &actions, nil, &argv, &env) == 0 else {
    throw Failure("SIGNING_COMMAND_START_FAILED")
  }
  onStart?(child)
  let deadline = ProcessInfo.processInfo.systemUptime + limit
  var status: Int32 = 0
  while true {
    let waited = waitpid(child, &status, WNOHANG)
    if waited == child { break }
    if waited < 0 && errno != EINTR { throw Failure("SIGNING_COMMAND_WAIT_FAILED") }
    if ProcessInfo.processInfo.systemUptime >= deadline || interrupted != 0 {
      kill(child, SIGKILL)
      _ = waitpid(child, &status, 0)
      throw Failure(interrupted == 0 ? "SIGNING_TIMEOUT" : "SIGNING_INTERRUPTED")
    }
    usleep(20_000)
  }
  guard status == 0 else { throw Failure("SIGNING_COMMAND_FAILED") }
}

private func lockPath(_ keychainPath: String) -> String {
  let digest = SHA256.hash(
    data: Data(URL(fileURLWithPath: keychainPath).resolvingSymlinksInPath().path.utf8)
  )
  .map { String(format: "%02x", $0) }.joined()
  return URL(fileURLWithPath: keychainPath).deletingLastPathComponent().appendingPathComponent(
    ".boa-signing-\(digest).lock"
  ).path
}

private final class Lease {
  let fd: Int32
  init(_ path: String, timeout: TimeInterval = 30) throws {
    fd = open(lockPath(path), O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw Failure("SIGNING_LOCK_FAILED") }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_uid == getuid(), st.st_mode & 0o077 == 0 else {
      close(fd)
      throw Failure("UNSAFE_SIGNING_LOCK")
    }
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while flock(fd, LOCK_EX | LOCK_NB) != 0 {
      if errno != EWOULDBLOCK || ProcessInfo.processInfo.systemUptime >= deadline
        || interrupted != 0
      {
        close(fd)
        throw Failure("SIGNING_BUSY")
      }
      usleep(20_000)
    }
  }
  deinit { close(fd) }  // No unlink: every client must keep using the same lock inode.
}

private func spawnWatchdog(_ configPath: String, _ lease: Lease, bootstrap: Bool) throws -> (
  pid_t, Int32
) {
  var pipeFDs: [Int32] = [0, 0]
  var readyFDs: [Int32] = [0, 0]
  guard pipe(&readyFDs) == 0 else { throw Failure("WATCHDOG_START_FAILED") }
  defer {
    close(readyFDs[0])
    close(readyFDs[1])
  }
  guard pipe(&pipeFDs) == 0 else { throw Failure("WATCHDOG_START_FAILED") }
  defer { close(pipeFDs[0]) }
  _ = fcntl(pipeFDs[1], F_SETFD, FD_CLOEXEC)
  var actions: posix_spawn_file_actions_t?
  posix_spawn_file_actions_init(&actions)
  defer { posix_spawn_file_actions_destroy(&actions) }
  for descriptor: Int32 in [0, 1, 2] {
    guard
      posix_spawn_file_actions_addopen(
        &actions, descriptor, "/dev/null", descriptor == 0 ? O_RDONLY : O_WRONLY, 0) == 0
    else {
      throw Failure("WATCHDOG_START_FAILED")
    }
  }
  // High destination numbers avoid clobbering the source descriptors during dup2.
  posix_spawn_file_actions_adddup2(&actions, lease.fd, 100)
  posix_spawn_file_actions_adddup2(&actions, pipeFDs[0], 101)
  posix_spawn_file_actions_adddup2(&actions, readyFDs[1], 102)
  posix_spawn_file_actions_addclose(&actions, pipeFDs[1])
  let arguments = [
    CommandLine.arguments[0], bootstrap ? "bootstrap-watchdog" : "watchdog", configPath,
    String(getpid()),
  ]
  let pointers = arguments.map { strdup($0) }
  defer { for pointer in pointers { free(pointer) } }
  var argv = pointers + [nil]
  var child: pid_t = 0
  let status = posix_spawn(&child, arguments[0], &actions, nil, &argv, environ)
  guard status == 0 else {
    close(pipeFDs[1])
    throw Failure("WATCHDOG_START_FAILED")
  }
  var ready = pollfd(fd: readyFDs[0], events: Int16(POLLIN), revents: 0)
  var byte: UInt8 = 0
  guard poll(&ready, 1, 5_000) == 1, read(readyFDs[0], &byte, 1) == 1, byte == 1 else {
    close(pipeFDs[1])
    kill(child, SIGKILL)
    var status: Int32 = 0
    _ = waitpid(child, &status, 0)
    throw Failure("WATCHDOG_START_FAILED")
  }
  return (child, pipeFDs[1])
}

private func watchdog(_ config: Config, _ parent: pid_t) throws {
  guard setpgid(0, 0) == 0 else { throw Failure("WATCHDOG_GROUP_FAILED") }
  // These descriptors are supplied only by the signed helper; never acquire/unlock a keychain here.
  var st = stat()
  guard fstat(100, &st) == 0, st.st_uid == getuid(), st.st_mode & S_IFMT == S_IFREG,
    fcntl(101, F_GETFD) >= 0
  else { throw Failure("INVALID_WATCHDOG") }
  var expectedLock = stat()
  guard stat(lockPath(config.keychainPath), &expectedLock) == 0,
    st.st_ino == expectedLock.st_ino, st.st_dev == expectedLock.st_dev,
    getpgid(parent) == parent
  else { throw Failure("INVALID_WATCHDOG") }
  var ready: UInt8 = 1
  guard Darwin.write(102, &ready, 1) == 1 else { throw Failure("WATCHDOG_START_FAILED") }
  close(102)
  var item = pollfd(fd: 101, events: Int16(POLLIN | POLLHUP), revents: 0)
  let event = poll(&item, 1, 90_000)
  var byte: UInt8 = 0
  let count = event > 0 ? read(101, &byte, 1) : 0
  if count == 1 && byte == 1 { exit(0) }
  // The main helper creates a dedicated process group inherited by codesign. This process stays outside it.
  _ = kill(-parent, SIGKILL)
  try closeKeychain(keychain(config.keychainPath))
  exit(0)
}

private func withVault<T>(
  _ config: Config, path: String, password: inout Data, bootstrap: Bool = false,
  body: (SecKeychain) throws -> T
) throws -> T {
  let lease = try Lease(config.keychainPath)
  defer { withExtendedLifetime(lease) {} }
  let ref = try keychain(config.keychainPath)
  // Refuse to interfere with an already-open vault belonging to an uncoordinated client.
  guard try !unlocked(ref) else { throw Failure("KEYCHAIN_ALREADY_UNLOCKED") }
  guard setpgid(0, 0) == 0 || getpgrp() == getpid() else { throw Failure("SIGNING_GROUP_FAILED") }
  let (watcher, channel) = try spawnWatchdog(path, lease, bootstrap: bootstrap)
  let result: Result<T, Error>
  do {
    try unlock(ref, &password)
    wipe(&password)
    result = .success(try body(ref))
  } catch {
    wipe(&password)
    result = .failure(error)
  }
  if case .failure(let error) = result {
    // Do not close a vault while a signer's descendants may still exist. EOF delegates process-group
    // termination and re-locking to the watchdog, whose inherited lease remains held after this exit.
    reportFailure(error)
    close(channel)
    _exit(1)
  }
  // Keep the lease until the watchdog has acknowledged clean shutdown or recovered the vault.
  do {
    try closeKeychain(ref)
    var done: UInt8 = 1
    guard Darwin.write(channel, &done, 1) == 1 else { throw Failure("WATCHDOG_FAILED") }
    close(channel)
    var status: Int32 = 0
    guard waitpid(watcher, &status, 0) == watcher, status == 0 else {
      throw Failure("WATCHDOG_FAILED")
    }
  } catch {
    close(channel)
    var status: Int32 = 0
    _ = waitpid(watcher, &status, 0)
    throw Failure("KEYCHAIN_RELOCK_FAILED")
  }
  return try result.get()
}

private func signingTargets(_ path: String) throws -> [String] {
  let root = URL(fileURLWithPath: path).resolvingSymlinksInPath()
  let installed = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/BOA.app").path
  guard root.path != installed, root.path != "/Applications/BOA.app", root.pathExtension == "app"
  else {
    throw Failure("DISPOSABLE_OR_STAGED_BUNDLE_REQUIRED")
  }
  let plist = try Data(contentsOf: root.appendingPathComponent("Contents/Info.plist"))
  guard
    let info = try PropertyListSerialization.propertyList(from: plist, format: nil)
      as? [String: Any],
    info["CFBundleIdentifier"] as? String == "com.julienm.boa",
    info["CFBundleExecutable"] as? String == "boa"
  else { throw Failure("EXPECTED_BOA_BUNDLE") }
  guard
    let iterator = fm.enumerator(
      at: root, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey])
  else {
    throw Failure("BUNDLE_INVENTORY_FAILED")
  }
  var targets = Set<String>()
  var visited = 0
  for case let url as URL in iterator {
    visited += 1
    guard visited <= 20_000 else { throw Failure("BUNDLE_INVENTORY_LIMIT") }
    let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
    if values.isSymbolicLink == true {
      guard url.resolvingSymlinksInPath().path.hasPrefix(root.path + "/") else {
        throw Failure("EXTERNAL_BUNDLE_SYMLINK")
      }
      continue
    }
    if ["app", "framework", "xpc", "appex"].contains(url.pathExtension) {
      targets.insert(url.path)
    }
    if values.isRegularFile == true {
      let file = try FileHandle(forReadingFrom: url)
      defer { try? file.close() }
      let magic = try file.read(upToCount: 4) ?? Data()
      if [
        Data([0xcf, 0xfa, 0xed, 0xfe]), Data([0xce, 0xfa, 0xed, 0xfe]),
        Data([0xca, 0xfe, 0xba, 0xbe]), Data([0xca, 0xfe, 0xba, 0xbf]),
      ].contains(magic),
        url.path != root.appendingPathComponent("Contents/MacOS/boa").path
      {
        targets.insert(url.path)
      }
    }
  }
  guard targets.count < 32 else { throw Failure("SIGNING_TARGET_LIMIT") }
  return targets.sorted { $0.count > $1.count } + [root.path]
}

private func signBundle(_ config: Config, _ ref: SecKeychain, _ bundle: String) throws {
  let targets = try signingTargets(bundle)
  let selected = try identity(ref, config.identity)
  try checkSigningAccess(selected)
  try run(
    "/usr/bin/security", ["find-identity", "-v", "-p", "codesigning", config.keychainPath], limit: 5
  )
  let deadline = ProcessInfo.processInfo.systemUptime + 50
  for target in targets {
    let remaining = deadline - ProcessInfo.processInfo.systemUptime
    guard remaining > 0 else { throw Failure("SIGNING_TIMEOUT") }
    try run(
      "/usr/bin/codesign",
      [
        "--force", "--sign", config.identity, "--keychain", config.keychainPath,
        "--timestamp=none", "--preserve-metadata=entitlements,flags,runtime", target,
      ], limit: min(20, remaining))
    try verifySigner(target, config.identity)
  }
  try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], limit: 5)
}

private func storePassword(_ password: Data) throws {
  let login = try loginKeychain()
  var query = credentialQuery(login)
  query[kSecReturnRef as String] = true
  var existing: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &existing)
  if status == errSecSuccess {
    guard let existing = existing else { throw Failure("EXISTING_CREDENTIAL_ACCESS_UNVERIFIED") }
    try checkCredentialAccess(unsafeBitCast(existing, to: SecKeychainItem.self))
    var saved = try passwordFromLogin()
    defer { wipe(&saved) }
    guard saved == password else { throw Failure("EXISTING_CREDENTIAL_MISMATCH") }
    return
  }
  guard status == errSecItemNotFound else { throw Failure("CREDENTIAL_LOOKUP_FAILED", status) }
  var trusted: SecTrustedApplication?
  try checked(SecTrustedApplicationCreateFromPath(nil, &trusted), "HELPER_TRUST_FAILED")
  guard let trusted = trusted else { throw Failure("HELPER_TRUST_FAILED") }
  var access: SecAccess?
  try checked(
    SecAccessCreate("Local app signing password" as CFString, [trusted] as CFArray, &access),
    "HELPER_TRUST_FAILED")
  guard let access = access else { throw Failure("HELPER_TRUST_FAILED") }
  let add: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service, kSecAttrAccount as String: NSUserName(),
    kSecValueData as String: password, kSecUseKeychain as String: login,
    kSecAttrAccess as String: access, kSecReturnRef as String: true,
  ]
  var created: CFTypeRef?
  try checked(SecItemAdd(add as CFDictionary, &created), "CREDENTIAL_CREATE_FAILED")
  guard let created = created else { throw Failure("CREDENTIAL_READBACK_FAILED") }
  try checkCredentialAccess(unsafeBitCast(created, to: SecKeychainItem.self))
  var readback = try passwordFromLogin()
  defer { wipe(&readback) }
  guard readback == password else { throw Failure("CREDENTIAL_READBACK_FAILED") }
}

private func provision(_ config: Config, _ path: String) throws {
  try verifySelf(config)
  var password = try ttyPassword()
  defer { wipe(&password) }
  // withVault wipes its copy. Keep a separate mutable buffer only until the native item is stored.
  var forUnlock = password
  defer { wipe(&forUnlock) }
  try withVault(config, path: path, password: &forUnlock) { ref in
    try checkSigningAccess(identity(ref, config.identity))
    var settings = SecKeychainSettings(
      version: UInt32(SEC_KEYCHAIN_SETTINGS_VERS1), lockOnSleep: false, useLockInterval: false,
      lockInterval: 0)
    try checked(SecKeychainCopySettings(ref, &settings), "KEYCHAIN_SETTINGS_UNAVAILABLE")
    let backup = URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(
      "keychain-settings-before.json")
    if !fm.fileExists(atPath: backup.path) {
      let record: [String: Any] = [
        "lockOnSleep": settings.lockOnSleep.boolValue,
        "useLockInterval": settings.useLockInterval.boolValue,
        "lockInterval": settings.lockInterval,
      ]
      try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]).write(
        to: backup, options: .withoutOverwriting)
      try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: backup.path)
    }
    try storePassword(password)
    settings.lockOnSleep = true
    settings.useLockInterval = true
    settings.lockInterval = 120
    try checked(SecKeychainSetSettings(ref, &settings), "KEYCHAIN_SETTINGS_FAILED")
    var readback = SecKeychainSettings(
      version: UInt32(SEC_KEYCHAIN_SETTINGS_VERS1), lockOnSleep: false, useLockInterval: false,
      lockInterval: 0)
    try checked(SecKeychainCopySettings(ref, &readback), "KEYCHAIN_SETTINGS_FAILED")
    guard
      readback.lockOnSleep.boolValue && readback.useLockInterval.boolValue
        && readback.lockInterval == 120
    else { throw Failure("KEYCHAIN_SETTINGS_FAILED") }
  }
  try emit(["provisioned": true, "relocked": true, "enabled": false])
}

private func bootstrap(_ config: Config, _ path: String) throws {
  guard isatty(STDIN_FILENO) == 1 else { throw Failure("INTERACTIVE_TERMINAL_REQUIRED") }
  guard !fm.fileExists(atPath: config.helperPath) else { throw Failure("HELPER_ALREADY_EXISTS") }
  var password = try ttyPassword()
  defer { wipe(&password) }
  try withVault(config, path: path, password: &password, bootstrap: true) { ref in
    _ = try identity(ref, config.identity)
    do {
      try fm.copyItem(atPath: CommandLine.arguments[0], toPath: config.helperPath)
      try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: config.helperPath)
      // Only this explicitly attended step may show the key's one-time authorization dialog.
      try run(
        "/usr/bin/codesign",
        [
          "--force", "--sign", config.identity, "--keychain", config.keychainPath,
          "--timestamp=none", "--identifier", helperIdentifier, config.helperPath,
        ], limit: 80)
      try verifySigner(config.helperPath, config.identity, identifier: helperIdentifier)
    } catch {
      // This path was absent at entry and is owned by this setup. Preserve all pre-existing files.
      try? fm.removeItem(atPath: config.helperPath)
      throw error
    }
  }
  try emit(["helperSigned": true, "relocked": true])
}

private func reportFailure(_ error: Error) {
  if let failure = error as? Failure {
    let status = failure.status.map { " \($0)" } ?? ""
    FileHandle.standardError.write(Data("\(failure.code)\(status)\n".utf8))
  } else {
    FileHandle.standardError.write(Data("NATIVE_SIGNING_FAILED\n".utf8))
  }
}

private func checkCredentialAccess(_ item: SecKeychainItem) throws {
  var access: SecAccess?
  try checked(SecKeychainItemCopyAccess(item, &access), "EXISTING_CREDENTIAL_ACCESS_UNVERIFIED")
  guard let access = access else { throw Failure("EXISTING_CREDENTIAL_ACCESS_UNVERIFIED") }
  try inspectCredentialAccess(access)
}

private func inspectCredentialAccess(_ access: SecAccess) throws {
  var trusted: SecTrustedApplication?
  try checked(SecTrustedApplicationCreateFromPath(nil, &trusted), "HELPER_TRUST_FAILED")
  guard let trusted = trusted else { throw Failure("HELPER_TRUST_FAILED") }
  let expected = try trustedData(trusted)
  let decrypt = SecAccessCopyMatchingACLList(access, kSecACLAuthorizationDecrypt) as? [SecACL] ?? []
  guard decrypt.count == 1 else { throw Failure("EXISTING_CREDENTIAL_ACCESS_UNVERIFIED") }
  var apps: CFArray?
  var text: CFString?
  var prompt = SecKeychainPromptSelector()
  try checked(
    SecACLCopyContents(decrypt[0], &apps, &text, &prompt), "EXISTING_CREDENTIAL_ACCESS_UNVERIFIED")
  guard !prompt.contains(.requirePassphase), let list = apps as? [SecTrustedApplication],
    list.count == 1,
    try trustedData(list[0]) == expected
  else { throw Failure("EXISTING_CREDENTIAL_ACCESS_UNVERIFIED") }
  // The exact helper-only decrypt ACL is mandatory. Partition constraints can only further restrict it;
  // native readback below proves this signed helper is also allowed by the stored partition constraint.
}

// The self-test constructs ACL objects in memory only; no certificate, key or stored credential is involved.
private func selfTest() throws {
  var trusted: SecTrustedApplication?
  try checked(
    SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &trusted), "TEST_TRUST_FAILED")
  guard let trusted = trusted else { throw Failure("TEST_TRUST_FAILED") }
  var accessRef: SecAccess?
  try checked(
    SecAccessCreate("BOA ephemeral ACL test" as CFString, [trusted] as CFArray, &accessRef),
    "TEST_ACCESS_FAILED")
  guard let access = accessRef else { throw Failure("TEST_ACCESS_FAILED") }
  guard
    let signing = (SecAccessCopyMatchingACLList(access, kSecACLAuthorizationSign) as? [SecACL])?
      .first
  else { throw Failure("TEST_ACL_FAILED") }
  let xml = try PropertyListSerialization.data(
    fromPropertyList: ["Partitions": ["apple:"]], format: .xml, options: 0)
  guard let text = String(data: xml, encoding: .utf8) else { throw Failure("TEST_ACL_FAILED") }
  var partition: SecACL?
  try checked(
    SecACLCreateWithSimpleContents(access, nil, text as CFString, [], &partition), "TEST_ACL_FAILED"
  )
  guard let partition = partition else { throw Failure("TEST_ACL_FAILED") }
  try checked(
    SecACLUpdateAuthorizations(partition, [kSecACLAuthorizationPartitionID] as CFArray),
    "TEST_ACL_FAILED")
  try inspectAccess(access)
  try checked(
    SecACLSetContents(signing, [trusted] as CFArray, "signing-test" as CFString, .requirePassphase),
    "TEST_ACL_FAILED")
  var refused = false
  do { try inspectAccess(access) } catch let failure as Failure {
    refused = failure.code == "CODESIGN_ACCESS_NOT_PROVISIONED"
  }
  guard refused else { throw Failure("TEST_REQUIRED_PASSPHRASE_NOT_REFUSED") }
  var selfApp: SecTrustedApplication?
  try checked(SecTrustedApplicationCreateFromPath(nil, &selfApp), "TEST_TRUST_FAILED")
  guard let selfApp = selfApp else { throw Failure("TEST_TRUST_FAILED") }
  var credentialAccess: SecAccess?
  try checked(
    SecAccessCreate("credential-test" as CFString, [selfApp] as CFArray, &credentialAccess),
    "TEST_ACCESS_FAILED")
  guard let credentialAccess = credentialAccess else { throw Failure("TEST_ACCESS_FAILED") }
  try inspectCredentialAccess(credentialAccess)
  guard
    let decrypt =
      (SecAccessCopyMatchingACLList(credentialAccess, kSecACLAuthorizationDecrypt) as? [SecACL])?
      .first
  else { throw Failure("TEST_ACCESS_FAILED") }
  try checked(
    SecACLSetContents(decrypt, [selfApp, trusted] as CFArray, "credential-test" as CFString, []),
    "TEST_ACL_FAILED")
  var broadRefused = false
  do { try inspectCredentialAccess(credentialAccess) } catch let failure as Failure {
    broadRefused = failure.code == "EXISTING_CREDENTIAL_ACCESS_UNVERIFIED"
  }
  guard broadRefused else { throw Failure("TEST_BROAD_CREDENTIAL_NOT_REFUSED") }
  var timedOut = false
  do { try run("/bin/sleep", ["2"], limit: 0.05) } catch let failure as Failure {
    timedOut = failure.code == "SIGNING_TIMEOUT"
  }
  guard timedOut else { throw Failure("TEST_TIMEOUT_NOT_ENFORCED") }
  try emit([
    "aclExactApp": true, "passphraseRefused": true, "childTimeoutEnforced": true,
    "broadCredentialRefused": true,
  ])
}

private func leaseTest(_ path: String, _ milliseconds: UInt32) throws {
  let real = URL(fileURLWithPath: path).resolvingSymlinksInPath()
  let temp = URL(fileURLWithPath: NSTemporaryDirectory()).resolvingSymlinksInPath().path
  guard real.path.hasPrefix(temp + "/boa-signing-test-"), milliseconds <= 500 else {
    throw Failure("TEST_PATH_REQUIRED")
  }
  try privateFile(real.path)
  let lease = try Lease(real.path, timeout: 0.05)
  defer { withExtendedLifetime(lease) {} }
  try emit(["leased": true])
  usleep(milliseconds * 1_000)
}

#if BOA_SIGNING_TESTS
  private func testPath(_ path: String) throws {
    let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    let temp = URL(fileURLWithPath: NSTemporaryDirectory()).resolvingSymlinksInPath().path
    guard canonical.hasPrefix(temp + "/boa-signing-test-"), canonical.hasSuffix(".keychain-db")
    else { throw Failure("TEST_PATH_REQUIRED") }
  }

  private func vaultTest(_ action: String, _ path: String) throws {
    try testPath(path)
    let configPath = path + ".json"
    if action == "vault-setup" {
      var ref: SecKeychain?
      let secret = Data("BOA-TEST-ONLY-NOT-A-REAL-CREDENTIAL".utf8)
      let status = secret.withUnsafeBytes {
        SecKeychainCreate(path, UInt32($0.count), $0.baseAddress, false, nil, &ref)
      }
      try checked(status, "TEST_KEYCHAIN_CREATE_FAILED")
      guard let ref = ref else { throw Failure("TEST_KEYCHAIN_CREATE_FAILED") }
      try closeKeychain(ref)
      let config = Config(
        version: 2, identity: String(repeating: "0", count: 40), keychainPath: path,
        credentialEntry: "local-app-signing/local/keychain-password",
        helperPath: CommandLine.arguments[0],
        helperSHA256: String(repeating: "0", count: 64),
        sourceSHA256: String(repeating: "0", count: 64), enabled: false)
      try JSONEncoder().encode(config).write(
        to: URL(fileURLWithPath: configPath), options: .withoutOverwriting)
      try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configPath)
      try emit(["created": true])
      return
    }
    if action == "vault-remove" {
      try checked(SecKeychainDelete(keychain(path)), "TEST_KEYCHAIN_DELETE_FAILED")
      try emit(["removed": true])
      return
    }
    let config = try Config.read(configPath)
    var password = Data("BOA-TEST-ONLY-NOT-A-REAL-CREDENTIAL".utf8)
    try withVault(config, path: configPath, password: &password) { ref in
      guard try unlocked(ref) else { throw Failure("TEST_VAULT_NOT_UNLOCKED") }
      try emit(["unlocked": true])
      if action == "vault-fail" { throw Failure("TEST_BODY_FAILED") }
      if action == "vault-hold" {
        // A long-lived child exercises watchdog process-group cleanup if this helper is killed.
        try run(
          "/bin/sleep", ["20"], limit: 20,
          onStart: { child in
            try? emit(["childPID": child, "childGroup": getpgid(child), "ownerGroup": getpgrp()])
          })
      }
    }
    try emit(["relocked": true])
  }
#endif

private func screenLocked() -> Bool? {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  return session?["CGSSessionScreenIsLocked"] as? Bool
}

private func main() throws {
  try checked(SecKeychainSetUserInteractionAllowed(false), "NO_UI_SETUP_FAILED")
  signal(SIGTERM) { _ in interrupted = SIGTERM }
  signal(SIGINT) { _ in interrupted = SIGINT }
  signal(SIGPIPE, SIG_IGN)
  let args = Array(CommandLine.arguments.dropFirst())
  guard let action = args.first else { throw Failure("USAGE") }
  #if BOA_SIGNING_TESTS
    if action == "credential-timeout-test", args.count == 1 {
      try boundedCredentialLookup(limit: 0.05) { usleep(500_000) }
      throw Failure("TEST_LOOKUP_TIMEOUT_NOT_ENFORCED")
    }
    if ["vault-setup", "vault-fail", "vault-hold", "vault-remove"].contains(action), args.count == 2
    {
      try vaultTest(action, args[1])
      return
    }
  #endif
  if action == "self-test", args.count == 1 {
    try selfTest()
    return
  }
  if action == "lease-test", args.count == 3, let milliseconds = UInt32(args[2]) {
    try leaseTest(args[1], milliseconds)
    return
  }
  if action == "screen" {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    try emit([
      "locked": screenLocked() ?? NSNull() as Any,
      "onConsole": session?[kCGSessionOnConsoleKey as String] as? Bool ?? false,
      "signal": "CGSession-advisory", "uptime": ProcessInfo.processInfo.systemUptime,
    ])
    return
  }
  if action == "probe", args.count == 2 {
    let dedicated = try keychain(args[1])
    let login = try keychain(
      fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Keychains/login.keychain-db")
        .path)
    try emit(["dedicatedUnlocked": try unlocked(dedicated), "loginUnlocked": try unlocked(login)])
    return
  }
  guard args.count >= 2 else { throw Failure("USAGE") }
  let config = try Config.read(args[1])
  if ["watchdog", "bootstrap-watchdog"].contains(action), args.count == 3,
    let parent = pid_t(args[2]), parent > 1
  {
    // The bootstrap watchdog never reads a credential or unlocks a vault. Its inherited lease and
    // live parent process-group are checked before it can perform recovery.
    if action == "watchdog" { try verifySelf(config) }
    try watchdog(config, parent)
    return
  }
  if action == "bootstrap", args.count == 2 {
    try bootstrap(config, args[1])
    return
  }
  try verifySelf(config)
  if action == "provision", args.count == 2 {
    try provision(config, args[1])
    return
  }
  guard (action == "doctor" && args.count == 2) || (action == "sign" && args.count == 3) else {
    throw Failure("USAGE")
  }
  let screenAtStart = screenLocked()
  var password = try passwordFromLogin()
  defer { wipe(&password) }
  try withVault(config, path: args[1], password: &password) { ref in
    let selected = try identity(ref, config.identity)
    try checkSigningAccess(selected)
    if action == "sign" { try signBundle(config, ref, args[2]) }
  }
  try emit([
    "action": action, "relocked": true, "identity": config.identity,
    "screenLockedAtStart": screenAtStart ?? NSNull() as Any,
    "screenLockedAtEnd": screenLocked() ?? NSNull() as Any,
  ])
}

do { try main() } catch let error as Failure {
  // Domain error codes only. Never print a password, arbitrary process stderr or an exception payload.
  let value = error.status.map { " \($0)" } ?? ""
  FileHandle.standardError.write(Data("\(error.code)\(value)\n".utf8))
  exit(1)
} catch {
  FileHandle.standardError.write(Data("NATIVE_SIGNING_FAILED\n".utf8))
  exit(1)
}

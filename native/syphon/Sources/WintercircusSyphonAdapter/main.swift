import AppKit
import CoreImage
import Foundation
import ImageIO
import Metal
import Syphon
import UniformTypeIdentifiers

struct Arguments {
  let wsUrl: URL
  let source: String?
  let fps: Double
  let width: Int
  let quality: Double
  let listSources: Bool
}

struct SourceItem: Codable {
  let target: String
  let label: String
  let protocolName: String
  let sourceName: String?
  let appName: String?
  let isLive: Bool
}

struct SourceListPayload: Codable {
  let items: [SourceItem]
}

func parseArguments() -> Arguments {
  let arguments = Array(CommandLine.arguments.dropFirst())
  var wsUrl = URL(string: "ws://localhost:8787/ingest")!
  var source: String?
  var fps = 30.0
  var width = 4096
  var quality = 0.86
  var listSources = false

  var index = 0
  while index < arguments.count {
    let argument = arguments[index]
    if argument == "--ws", index + 1 < arguments.count, let url = URL(string: arguments[index + 1]) {
      wsUrl = url
      index += 2
      continue
    }

    if argument == "--source", index + 1 < arguments.count {
      source = arguments[index + 1]
      index += 2
      continue
    }

    if argument == "--fps", index + 1 < arguments.count, let value = Double(arguments[index + 1]) {
      fps = max(value, 1)
      index += 2
      continue
    }

    if argument == "--width", index + 1 < arguments.count, let value = Int(arguments[index + 1]) {
      width = max(value, 256)
      index += 2
      continue
    }

    if argument == "--quality", index + 1 < arguments.count, let value = Double(arguments[index + 1]) {
      quality = min(max(value, 0.1), 1.0)
      index += 2
      continue
    }

    if argument == "--list-sources" {
      listSources = true
      index += 1
      continue
    }

    index += 1
  }

  return Arguments(
    wsUrl: wsUrl,
    source: source?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
    fps: fps,
    width: width,
    quality: quality,
    listSources: listSources
  )
}

extension String {
  var nilIfEmpty: String? {
    isEmpty ? nil : self
  }
}

final class Logger {
  static func info(_ message: String) {
    fputs("\(message)\n", stderr)
  }
}

func writeSourceList(_ items: [SourceItem]) throws {
  let encoder = JSONEncoder()
  let data = try encoder.encode(SourceListPayload(items: items))
  FileHandle.standardOutput.write(data)
}

final class WebSocketSender: NSObject, URLSessionWebSocketDelegate {
  private let task: URLSessionWebSocketTask
  private let session: URLSession

  init(url: URL) {
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 10
    self.session = URLSession(configuration: configuration)
    self.task = session.webSocketTask(with: url)
    super.init()
    task.resume()
  }

  deinit {
    task.cancel(with: .normalClosure, reason: nil)
    session.invalidateAndCancel()
  }

  func sendMeta(label: String) {
    let payload = #"{"type":"meta","label":"\#(label.replacingOccurrences(of: "\"", with: "\\\""))"}"#
    task.send(.string(payload)) { error in
      if let error {
        Logger.info("WebSocket meta send failed: \(error.localizedDescription)")
      }
    }
  }

  func sendFrame(_ data: Data) {
    task.send(.data(data)) { error in
      if let error {
        Logger.info("WebSocket frame send failed: \(error.localizedDescription)")
      }
    }
  }
}

final class SyphonBridgeAdapter {
  private let arguments: Arguments
  private let sender: WebSocketSender
  private let device: MTLDevice
  private let ciContext: CIContext
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
  private var client: SyphonMetalClient?
  private var frameTimer: DispatchSourceTimer?
  private var discoveryTimer: DispatchSourceTimer?
  private var isSendingFrame = false

  init(arguments: Arguments) throws {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw NSError(domain: "WintercircusSyphonAdapter", code: 10, userInfo: [
        NSLocalizedDescriptionKey: "No Metal device available.",
      ])
    }

    self.arguments = arguments
    self.device = device
    self.ciContext = CIContext(mtlDevice: device)
    self.sender = WebSocketSender(url: arguments.wsUrl)
  }

  func run() {
    sender.sendMeta(label: "Syphon adapter started.")
    Logger.info("Syphon adapter started.")
    Logger.info("Bridge: \(arguments.wsUrl.absoluteString)")
    if let source = arguments.source {
      Logger.info("Requested Syphon source: \(source)")
    }

    startDiscoveryLoop()
    startFrameLoop()
    RunLoop.main.run()
  }

  private func startDiscoveryLoop() {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
    timer.schedule(deadline: .now(), repeating: .seconds(1))
    timer.setEventHandler { [weak self] in
      self?.refreshClient()
    }
    timer.resume()
    discoveryTimer = timer
  }

  private func startFrameLoop() {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
    let intervalNanoseconds = UInt64((1.0 / arguments.fps) * 1_000_000_000.0)
    timer.schedule(deadline: .now(), repeating: .nanoseconds(Int(intervalNanoseconds)))
    timer.setEventHandler { [weak self] in
      self?.captureFrame()
    }
    timer.resume()
    frameTimer = timer
  }

  private func refreshClient() {
    if let client, client.isValid {
      return
    }

    client?.stop()
    client = nil

    let availableServers = SyphonServerDirectory.shared().servers
    guard let description = selectServer(from: availableServers) else {
      sender.sendMeta(label: arguments.source == nil ? "Syphon: waiting for any server" : "Syphon: waiting for \(arguments.source!)")
      return
    }

    let newClient = SyphonMetalClient(
      serverDescription: description,
      device: device,
      options: nil,
      newFrameHandler: nil
    )

    guard newClient.isValid else {
      Logger.info("Failed to connect to selected Syphon server.")
      return
    }

    client = newClient
    let label = serverLabel(from: description)
    sender.sendMeta(label: "Syphon: \(label)")
    Logger.info("Connected to Syphon source: \(label)")
  }

  private func selectServer(from servers: [[String: any NSCoding]]) -> [String: any NSCoding]? {
    if let target = arguments.source?.lowercased() {
      return servers.first { description in
        let name = (description[SyphonServerDescriptionNameKey] as? String ?? "").lowercased()
        let app = (description[SyphonServerDescriptionAppNameKey] as? String ?? "").lowercased()
        let combined = "\(app) \(name)"
        let labeled = "\(app) / \(name)"
        return name == target || app == target || combined.contains(target) || labeled == target
      }
    }

    return servers.first
  }

  private func serverLabel(from description: [String: any NSCoding]) -> String {
    let name = description[SyphonServerDescriptionNameKey] as? String ?? "Unnamed"
    let app = description[SyphonServerDescriptionAppNameKey] as? String ?? "Unknown App"
    return "\(app) / \(name)"
  }

  private func captureFrame() {
    guard !isSendingFrame else {
      return
    }

    guard let client, client.isValid, client.hasNewFrame else {
      return
    }

    guard let texture = client.newFrameImage() else {
      return
    }

    guard let data = makeJPEGData(from: texture) else {
      return
    }

    isSendingFrame = true
    sender.sendFrame(data)
    isSendingFrame = false
  }

  private func makeJPEGData(from texture: MTLTexture) -> Data? {
    guard let baseImage = CIImage(mtlTexture: texture, options: [
      .colorSpace: colorSpace,
    ]) else {
      Logger.info("Could not create CIImage from Syphon texture.")
      return nil
    }

    let extent = CGRect(x: 0, y: 0, width: texture.width, height: texture.height)
    var image = baseImage.cropped(to: extent)

    if texture.width > arguments.width {
      let scale = CGFloat(arguments.width) / CGFloat(texture.width)
      image = image.applyingFilter("CILanczosScaleTransform", parameters: [
        "inputScale": scale,
        "inputAspectRatio": 1.0,
      ])
    }

    let background = CIImage(color: .black).cropped(to: image.extent)
    image = image.composited(over: background)

    guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
      Logger.info("Could not render CGImage from Syphon frame.")
      return nil
    }

    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data,
        UTType.jpeg.identifier as CFString,
        1,
        nil
      )
    else {
      Logger.info("Could not create JPEG destination.")
      return nil
    }

    CGImageDestinationAddImage(destination, cgImage, [
      kCGImageDestinationLossyCompressionQuality: arguments.quality,
    ] as CFDictionary)

    guard CGImageDestinationFinalize(destination) else {
      Logger.info("Could not finalize JPEG frame.")
      return nil
    }

    return data as Data
  }
}

let arguments = parseArguments()

do {
  if arguments.listSources {
    let items = SyphonServerDirectory.shared().servers.compactMap { description -> SourceItem? in
      let name = description[SyphonServerDescriptionNameKey] as? String ?? "Unnamed"
      let app = description[SyphonServerDescriptionAppNameKey] as? String ?? "Unknown App"
      let label = "\(app) / \(name)"
      return SourceItem(
        target: label,
        label: "\(label) [live]",
        protocolName: "syphon",
        sourceName: name,
        appName: app,
        isLive: true
      )
    }
    try writeSourceList(items)
    exit(0)
  }

  try SyphonBridgeAdapter(arguments: arguments).run()
} catch {
  Logger.info("Syphon adapter failed: \(error.localizedDescription)")
  exit(1)
}

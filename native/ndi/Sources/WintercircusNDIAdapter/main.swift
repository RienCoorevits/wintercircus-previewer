import CNDI
import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

let bridgePacketMagic = Data("WCP1".utf8)
let bridgePacketKindVideo: UInt8 = 1
let bridgePacketKindAudio: UInt8 = 2

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

extension Data {
  mutating func appendInteger<T: FixedWidthInteger>(_ value: T) {
    var littleEndianValue = value.littleEndian
    Swift.withUnsafeBytes(of: &littleEndianValue) { rawBuffer in
      append(contentsOf: rawBuffer)
    }
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

func parseNDISourceName(_ rawName: String) -> (appName: String?, sourceName: String?) {
  let trimmed = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
  guard
    let openParenIndex = trimmed.lastIndex(of: "("),
    let closeParenIndex = trimmed.lastIndex(of: ")"),
    openParenIndex < closeParenIndex
  else {
    return (nil, trimmed.nilIfEmpty)
  }

  let host = trimmed[..<openParenIndex].trimmingCharacters(in: .whitespacesAndNewlines)
  let source = trimmed[trimmed.index(after: openParenIndex)..<closeParenIndex]
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return (host.nilIfEmpty, source.nilIfEmpty)
}

func listNDISources() throws {
  guard NDIlib_initialize() else {
    throw NSError(domain: "WintercircusNDIAdapter", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "NDIlib_initialize() failed.",
    ])
  }

  defer {
    NDIlib_destroy()
  }

  var findSettings = NDIlib_find_create_t()
  findSettings.show_local_sources = true
  findSettings.p_groups = nil
  findSettings.p_extra_ips = nil

  guard let finder = NDIlib_find_create_v2(&findSettings) else {
    throw NSError(domain: "WintercircusNDIAdapter", code: 2, userInfo: [
      NSLocalizedDescriptionKey: "Could not create NDI finder instance.",
    ])
  }

  defer {
    NDIlib_find_destroy(finder)
  }

  _ = NDIlib_find_wait_for_sources(finder, 1500)

  var numberOfSources: UInt32 = 0
  guard let sourcePointer = NDIlib_find_get_current_sources(finder, &numberOfSources) else {
    try writeSourceList([])
    return
  }

  let items = UnsafeBufferPointer(start: sourcePointer, count: Int(numberOfSources)).map { source in
    let name = source.p_ndi_name.flatMap { String(cString: $0) } ?? "Unnamed NDI Source"
    let parsed = parseNDISourceName(name)
    let label: String
    if let appName = parsed.appName, let sourceName = parsed.sourceName {
      label = "\(appName) / \(sourceName) [live]"
    } else {
      label = "\(name) [live]"
    }
    return SourceItem(
      target: name,
      label: label,
      protocolName: "ndi",
      sourceName: parsed.sourceName ?? name,
      appName: parsed.appName,
      isLive: true
    )
  }

  try writeSourceList(items)
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

final class NDIBridgeAdapter {
  private let arguments: Arguments
  private let sender: WebSocketSender
  private let ciContext = CIContext()
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
  private let finder: NDIlib_find_instance_t?
  private var receiver: NDIlib_recv_instance_t?
  private var lastSendTime = CFAbsoluteTimeGetCurrent()

  init(arguments: Arguments) throws {
    self.arguments = arguments
    self.sender = WebSocketSender(url: arguments.wsUrl)

    guard NDIlib_initialize() else {
      throw NSError(domain: "WintercircusNDIAdapter", code: 10, userInfo: [
        NSLocalizedDescriptionKey: "NDIlib_initialize() failed.",
      ])
    }

    var findSettings = NDIlib_find_create_t()
    findSettings.show_local_sources = true
    findSettings.p_groups = nil
    findSettings.p_extra_ips = nil
    self.finder = NDIlib_find_create_v2(&findSettings)

    if finder == nil {
      throw NSError(domain: "WintercircusNDIAdapter", code: 11, userInfo: [
        NSLocalizedDescriptionKey: "Could not create NDI finder instance.",
      ])
    }
  }

  deinit {
    if let receiver {
      NDIlib_recv_destroy(receiver)
    }
    if let finder {
      NDIlib_find_destroy(finder)
    }
    NDIlib_destroy()
  }

  func run() {
    sender.sendMeta(label: "NDI adapter started.")
    Logger.info("NDI adapter started.")
    Logger.info("Bridge: \(arguments.wsUrl.absoluteString)")
    if let source = arguments.source {
      Logger.info("Requested NDI source: \(source)")
    }

    while true {
      if receiver == nil {
        connectToSourceIfAvailable()
      }

      guard let receiver else {
        if let finder {
          _ = NDIlib_find_wait_for_sources(finder, 1000)
        } else {
          Thread.sleep(forTimeInterval: 1.0)
        }
        continue
      }

      var videoFrame = NDIlib_video_frame_v2_t()
      var audioFrame = NDIlib_audio_frame_v2_t()
      let frameType = NDIlib_recv_capture_v2(receiver, &videoFrame, &audioFrame, nil, 1000)

      switch frameType {
      case NDIlib_frame_type_video:
        handleVideoFrame(videoFrame, receiver: receiver)
      case NDIlib_frame_type_audio:
        handleAudioFrame(audioFrame, receiver: receiver)
      case NDIlib_frame_type_status_change:
        updateReceiverStatus(receiver)
      case NDIlib_frame_type_source_change:
        updateReceiverStatus(receiver)
      case NDIlib_frame_type_error:
        Logger.info("NDI receiver reported an error; reconnecting.")
        NDIlib_recv_destroy(receiver)
        self.receiver = nil
      default:
        break
      }
    }
  }

  private func connectToSourceIfAvailable() {
    guard let finder else {
      return
    }

    var numberOfSources: UInt32 = 0
    guard let sourcePointer = NDIlib_find_get_current_sources(finder, &numberOfSources) else {
      sender.sendMeta(label: "NDI: waiting for sources")
      return
    }

    let sources = UnsafeBufferPointer(start: sourcePointer, count: Int(numberOfSources))
    guard let selectedSource = selectSource(from: sources) else {
      sender.sendMeta(label: arguments.source == nil ? "NDI: waiting for any source" : "NDI: waiting for \(arguments.source!)")
      return
    }

    var recvSettings = NDIlib_recv_create_v3_t()
    recvSettings.source_to_connect_to = selectedSource
    recvSettings.color_format = NDIlib_recv_color_format_BGRX_BGRA
    recvSettings.bandwidth = NDIlib_recv_bandwidth_highest
    recvSettings.allow_video_fields = false
    let receiver = "Wintercircus Previewer".withCString { receiverName in
      recvSettings.p_ndi_recv_name = receiverName
      return NDIlib_recv_create_v3(&recvSettings)
    }

    guard let receiver else {
      Logger.info("Failed to create NDI receiver.")
      return
    }

    self.receiver = receiver
    sender.sendMeta(label: "NDI: \(sourceLabel(from: selectedSource))")
    Logger.info("Connected to NDI source: \(sourceLabel(from: selectedSource))")
  }

  private func selectSource(from sources: UnsafeBufferPointer<NDIlib_source_t>) -> NDIlib_source_t? {
    if let target = arguments.source?.lowercased() {
      return sources.first { source in
        let name = source.p_ndi_name.flatMap { String(cString: $0) }?.lowercased() ?? ""
        return name == target || name.contains(target)
      }
    }

    return sources.first
  }

  private func sourceLabel(from source: NDIlib_source_t) -> String {
    source.p_ndi_name.flatMap { String(cString: $0) } ?? "Unnamed NDI Source"
  }

  private func updateReceiverStatus(_ receiver: NDIlib_recv_instance_t) {
    var sourceNamePointer: UnsafePointer<CChar>?
    let didChange = NDIlib_recv_get_source_name(receiver, &sourceNamePointer, 0)
    if didChange, let sourceNamePointer {
      let name = String(cString: sourceNamePointer)
      sender.sendMeta(label: "NDI: \(name)")
      NDIlib_recv_free_string(receiver, sourceNamePointer)
    }
  }

  private func handleVideoFrame(_ videoFrame: NDIlib_video_frame_v2_t, receiver: NDIlib_recv_instance_t) {
    defer {
      var mutableFrame = videoFrame
      NDIlib_recv_free_video_v2(receiver, &mutableFrame)
    }

    let now = CFAbsoluteTimeGetCurrent()
    if now - lastSendTime < (1.0 / arguments.fps) {
      return
    }
    lastSendTime = now

    guard let jpegData = makeJPEGData(from: videoFrame) else {
      return
    }

    sender.sendFrame(makeBridgePacket(
      kind: bridgePacketKindVideo,
      timestamp: bridgeTimestamp(timestamp: videoFrame.timestamp, timecode: videoFrame.timecode),
      payload: jpegData
    ))
  }

  private func handleAudioFrame(_ audioFrame: NDIlib_audio_frame_v2_t, receiver: NDIlib_recv_instance_t) {
    defer {
      var mutableFrame = audioFrame
      NDIlib_recv_free_audio_v2(receiver, &mutableFrame)
    }

    guard let packet = makeAudioPacket(from: audioFrame) else {
      return
    }

    sender.sendFrame(packet)
  }

  private func makeJPEGData(from videoFrame: NDIlib_video_frame_v2_t) -> Data? {
    guard let framePointer = videoFrame.p_data else {
      return nil
    }

    let stride = max(videoFrame.line_stride_in_bytes, videoFrame.xres * 4)
    let dataSize = stride * videoFrame.yres
    let copiedData = Data(bytes: framePointer, count: Int(dataSize))
    let colorFormat = videoFrame.FourCC

    let alphaInfo: CGImageAlphaInfo
    if colorFormat == NDIlib_FourCC_video_type_BGRA {
      alphaInfo = .premultipliedFirst
    } else {
      alphaInfo = .noneSkipFirst
    }

    guard let provider = CGDataProvider(data: copiedData as CFData) else {
      return nil
    }

    let bitmapInfo = CGBitmapInfo.byteOrder32Little.union(CGBitmapInfo(rawValue: alphaInfo.rawValue))
    guard let cgImage = CGImage(
      width: Int(videoFrame.xres),
      height: Int(videoFrame.yres),
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: Int(stride),
      space: colorSpace,
      bitmapInfo: bitmapInfo,
      provider: provider,
      decode: nil,
      shouldInterpolate: false,
      intent: .defaultIntent
    ) else {
      return nil
    }

    var image = CIImage(cgImage: cgImage)
    if videoFrame.xres > arguments.width {
      let scale = CGFloat(arguments.width) / CGFloat(videoFrame.xres)
      image = image.applyingFilter("CILanczosScaleTransform", parameters: [
        "inputScale": scale,
        "inputAspectRatio": 1.0,
      ])
    }

    let background = CIImage(color: .black).cropped(to: image.extent)
    image = image.composited(over: background)

    guard let encodedCGImage = ciContext.createCGImage(image, from: image.extent) else {
      return nil
    }

    let outputData = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        outputData,
        UTType.jpeg.identifier as CFString,
        1,
        nil
      )
    else {
      return nil
    }

    CGImageDestinationAddImage(destination, encodedCGImage, [
      kCGImageDestinationLossyCompressionQuality: arguments.quality,
    ] as CFDictionary)

    guard CGImageDestinationFinalize(destination) else {
      return nil
    }

    return outputData as Data
  }

  private func makeAudioPacket(from audioFrame: NDIlib_audio_frame_v2_t) -> Data? {
    guard
      let framePointer = audioFrame.p_data,
      audioFrame.sample_rate > 0,
      audioFrame.no_channels > 0,
      audioFrame.no_samples > 0
    else {
      return nil
    }

    let channelCount = Int(audioFrame.no_channels)
    let sampleCount = Int(audioFrame.no_samples)
    let strideInFloats: Int
    if audioFrame.channel_stride_in_bytes > 0 {
      strideInFloats = Int(audioFrame.channel_stride_in_bytes) / MemoryLayout<Float>.size
    } else {
      strideInFloats = sampleCount
    }

    var interleavedSamples = Data(count: channelCount * sampleCount * MemoryLayout<Float>.size)
    interleavedSamples.withUnsafeMutableBytes { rawBuffer in
      guard let destination = rawBuffer.bindMemory(to: Float.self).baseAddress else {
        return
      }

      for sampleIndex in 0..<sampleCount {
        for channelIndex in 0..<channelCount {
          let channelBase = framePointer.advanced(by: channelIndex * strideInFloats)
          destination[sampleIndex * channelCount + channelIndex] = channelBase[sampleIndex]
        }
      }
    }

    var header = Data()
    header.appendInteger(UInt32(audioFrame.sample_rate))
    header.appendInteger(UInt16(channelCount))
    header.appendInteger(UInt32(sampleCount))
    header.append(0)

    return makeBridgePacket(
      kind: bridgePacketKindAudio,
      timestamp: bridgeTimestamp(timestamp: audioFrame.timestamp, timecode: audioFrame.timecode),
      header: header,
      payload: interleavedSamples
    )
  }

  private func bridgeTimestamp(timestamp: Int64, timecode: Int64) -> Int64? {
    if timestamp != NDIlib_recv_timestamp_undefined {
      return timestamp
    }

    if timecode != NDIlib_send_timecode_synthesize {
      return timecode
    }

    return nil
  }

  private func makeBridgePacket(kind: UInt8, timestamp: Int64?, header: Data = Data(), payload: Data) -> Data {
    var packet = Data()
    packet.append(bridgePacketMagic)
    packet.appendInteger(kind)
    packet.appendInteger(timestamp ?? -1)
    packet.append(header)
    packet.append(payload)
    return packet
  }
}

let arguments = parseArguments()

do {
  if arguments.listSources {
    try listNDISources()
    exit(0)
  }

  try NDIBridgeAdapter(arguments: arguments).run()
} catch {
  Logger.info("NDI adapter failed: \(error.localizedDescription)")
  exit(1)
}

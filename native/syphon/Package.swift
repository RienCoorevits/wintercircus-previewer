// swift-tools-version: 6.0
import PackageDescription
import Foundation

let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let frameworkDirectory = "\(packageDirectory)/build"

let package = Package(
  name: "WintercircusSyphonAdapter",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(
      name: "wintercircus-syphon-adapter",
      targets: ["WintercircusSyphonAdapter"],
    ),
  ],
  targets: [
    .executableTarget(
      name: "WintercircusSyphonAdapter",
      swiftSettings: [
        .unsafeFlags(["-F", frameworkDirectory]),
      ],
      linkerSettings: [
        .unsafeFlags([
          "-F", frameworkDirectory,
          "-Xlinker", "-rpath",
          "-Xlinker", frameworkDirectory,
          "-framework", "Syphon",
        ]),
      ],
    ),
  ],
)

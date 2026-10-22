// One bounded, local image per process. The main process owns authorization,
// request identity, cancellation and persistence; this helper never opens a DB.
import Foundation
import Vision
import ImageIO
import CryptoKit
import Darwin
import zlib

let helperVersion = "1.1.1"
let algorithm = "imageio-bounded-width-strips-spatial-candidates-v3"
let normalizationPolicy = "imageio-decode-v2"
let mergePolicy = "overlap-position-completeness-v2"
let readingOrderPolicy = "height-relative-baseline-clusters-v2"
let maximumInputBytes = 48 * 1024 * 1024
let maximumPixels = 60_000_000
let maximumDimension = 50_000
let maximumOutputBytes = 4 * 1024 * 1024
let maximumBlocks = 10_000
let maximumTextCodePoints = 1_000_000
let tileWidth = 8192, tileHeight = 3072, overlap = 256, maximumTiles = 64
let maximumOcrWidth = 8192, maximumTilePixels = 12_000_000
let wholeImageMaximumDimension = 4096, wholeImageMaximumPixels = 12_000_000
let maximumObservedResidentBytes = 1024 * 1024 * 1024
let limits: [String: Any] = ["maxInputBytes": maximumInputBytes, "maxPixels": maximumPixels,
    "maxDimension": maximumDimension, "maxOutputBytes": maximumOutputBytes,
    "maxBlocks": maximumBlocks, "maxTextCodePoints": maximumTextCodePoints,
    "timeoutMs": 90_000, "maxConcurrentImages": 1, "tileWidth": tileWidth,
    "tileHeight": tileHeight, "overlap": overlap, "maxTiles": maximumTiles,
    "wholeImageMaximumDimension": wholeImageMaximumDimension, "wholeImageMaximumPixels": wholeImageMaximumPixels,
    "maxOcrWidth": maximumOcrWidth, "maxTilePixels": maximumTilePixels,
    "decodedImageBytesUpperBound": maximumPixels * 8,
    "maxObservedResidentBytes": maximumObservedResidentBytes,
    "memoryPolicy": "bounded file/pixels/tile/output; RSS checked between tile requests, not a hard OS allocation cap; subprocess deadline/cancellation enforced by host"]

struct HelperError: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) throws -> Never { throw HelperError(code: code, message: message) }
func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
func residentPeak() -> Int {
    var usage = rusage()
    return getrusage(RUSAGE_SELF, &usage) == 0 ? Int(usage.ru_maxrss) : 0
}
func jsonData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
func emit(_ value: [String: Any], exitCode: Int32 = 0) -> Never {
    do {
        let data = try jsonData(value)
        guard data.count <= maximumOutputBytes else { throw HelperError(code: "output-limit", message: "图片文字输出超过上限") }
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); exit(exitCode)
    } catch {
        FileHandle.standardOutput.write(Data("{\"schemaVersion\":1,\"ok\":false,\"error\":{\"code\":\"output-limit\",\"message\":\"图片文字输出超过上限\"}}\n".utf8)); exit(1)
    }
}
func object(_ value: Any?, allowed: Set<String>, name: String) throws -> [String: Any] {
    guard let result = value as? [String: Any], Set(result.keys).isSubset(of: allowed) else { try fail("invalid-input", "\(name)结构无效") }
    return result
}
func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
          number.doubleValue.rounded() == number.doubleValue, number.doubleValue <= Double(Int.max), number.doubleValue >= Double(Int.min) else { return nil }
    return number.intValue
}
func operatingSystemBuild() -> String {
    var size = 0
    guard sysctlbyname("kern.osversion", nil, &size, nil, 0) == 0, size > 0 else { return "unknown" }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.osversion", &bytes, &size, nil, 0) == 0 else { return "unknown" }
    return String(cString: bytes)
}
func engineInfo(_ config: [String: Any]) throws -> [String: Any] {
    guard let executable = Bundle.main.executableURL, let executableBytes = try? Data(contentsOf: executable, options: .mappedIfSafe), !executableBytes.isEmpty else { try fail("helper-identity", "无法校验本地识别 helper 版本摘要") }
    let request = VNRecognizeTextRequest()
    let revision = integer(config["revision"]) ?? VNRecognizeTextRequest.currentRevision
    guard VNRecognizeTextRequest.supportedRevisions.contains(revision) else { try fail("unsupported-revision", "当前系统不支持所选 Vision 版本") }
    request.revision = revision; request.recognitionLevel = .accurate
    let supported = try request.supportedRecognitionLanguages()
    let languages = config["languages"] as? [String] ?? ["zh-Hans", "zh-Hant", "en-US"].filter { supported.contains($0) }
    guard !languages.isEmpty, languages.count <= 3, Set(languages).count == languages.count,
          languages.allSatisfy({ supported.contains($0) }), languages.contains(where: { $0.hasPrefix("zh-") }),
          languages.allSatisfy({ $0.hasPrefix("zh-") || $0.hasPrefix("en-") }) else { try fail("unsupported-languages", "需要当前系统支持的中文与英文组合") }
    if config["languages"] != nil && !(config["languages"] is [String]) { try fail("invalid-input", "识别语言结构无效") }
    if config["revision"] != nil && integer(config["revision"]) == nil { try fail("invalid-input", "识别版本无效") }
    #if arch(arm64)
    let architecture = "arm64"
    #elseif arch(x86_64)
    let architecture = "x86_64"
    #else
    let architecture = "unknown"
    #endif
    let version = ProcessInfo.processInfo.operatingSystemVersion
    var result: [String: Any] = ["id": "apple-vision", "version": helperVersion, "helperSha256": digest(executableBytes),
        "osVersion": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)", "osBuild": operatingSystemBuild(),
        "architecture": architecture, "minimumMacOS": "13.0", "revision": revision,
        "supportedRevisions": Array(VNRecognizeTextRequest.supportedRevisions), "supportedLanguages": supported,
        "languages": languages, "mode": "accurate", "usesLanguageCorrection": true, "minimumTextHeight": 0,
        "automaticallyDetectsLanguage": false, "algorithm": algorithm,
        "coordinateSystem": "orientation-normalized-original-top-left", "regionGranularity": "line-or-fragment",
        "normalizationPolicy": normalizationPolicy, "mergePolicy": mergePolicy,
        "tilePolicy": "whole-through-4096-and-12M-else-full-width-strips-v3",
        "readingOrder": readingOrderPolicy, "limits": limits]
    result["configSha256"] = digest(try jsonData(result))
    #if OCR_HELPER_TESTING
    result["testBuild"] = true
    result["configSha256"] = digest(try jsonData(result))
    #endif
    return result
}

func safeInput(_ input: [String: Any]) throws -> (Data, String) {
    guard let root = input["root"] as? String, root.hasPrefix("/"), !root.contains("\0"),
          let relative = input["relativePath"] as? String, !relative.isEmpty, !relative.hasPrefix("/"), !relative.contains("\\"), !relative.contains("\0") else { try fail("invalid-path", "固定图片路径无效") }
    let components = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }), root.count <= 4096, relative.count <= 4096 else { try fail("invalid-path", "固定图片路径无效") }
    let rootURL = URL(fileURLWithPath: root, isDirectory: true)
    guard rootURL.standardizedFileURL.path == root, rootURL.resolvingSymlinksInPath().path == root else { try fail("invalid-path", "固定图片目录不能使用别名或符号链接") }
    var url = rootURL
    for component in components {
        url.appendPathComponent(component)
        let attrs: [FileAttributeKey: Any]
        do { attrs = try FileManager.default.attributesOfItem(atPath: url.path) } catch { try fail("missing-file", "固定图片文件不存在") }
        if attrs[.type] as? FileAttributeType == .typeSymbolicLink { try fail("invalid-path", "固定图片不能使用符号链接") }
    }
    guard url.resolvingSymlinksInPath().path == url.path, url.path.hasPrefix(root + "/") else { try fail("invalid-path", "固定图片超出允许目录") }
    // Open each directory relative to an already pinned directory descriptor.
    // A path-component replacement between validation and open cannot redirect
    // this process through a symlink to an unrelated file.
    var directoryFD = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard directoryFD >= 0 else { try fail("invalid-path", "固定图片目录无法打开") }
    let directoryComponents = root.split(separator: "/").map(String.init) + components.dropLast()
    for component in directoryComponents {
        let next = openat(directoryFD, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        close(directoryFD)
        guard next >= 0 else { try fail("invalid-path", "固定图片目录无效或包含符号链接") }
        directoryFD = next
    }
    let fd = openat(directoryFD, components.last!, O_RDONLY | O_NOFOLLOW)
    close(directoryFD)
    guard fd >= 0 else { try fail("missing-file", "固定图片无法读取") }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { try fail("invalid-path", "固定图片不是普通文件") }
    guard st.st_size > 0, st.st_size <= maximumInputBytes else { try fail("input-limit", "图片文件为空或超过48MiB上限") }
    if let expected = input["expectedBytes"], integer(expected) != Int(st.st_size) { try fail("input-mismatch", "固定图片大小已变化") }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    let bytes: Data
    do { bytes = try handle.read(upToCount: maximumInputBytes + 1) ?? Data() } catch { try fail("read-failed", "固定图片读取失败") }
    guard bytes.count == Int(st.st_size), bytes.count <= maximumInputBytes else { try fail("input-mismatch", "固定图片读取期间已变化") }
    let sha = digest(bytes)
    if let expected = input["expectedSha256"] as? String, expected != sha { try fail("input-mismatch", "固定图片字节摘要已变化") }
    if input["expectedSha256"] != nil && !(input["expectedSha256"] is String) { try fail("invalid-input", "图片摘要结构无效") }
    return (bytes, sha)
}

func mimeType(_ bytes: Data) throws -> String {
    let b = [UInt8](bytes.prefix(16))
    if b.count >= 8 && Array(b[0..<8]) == [137,80,78,71,13,10,26,10] { return "image/png" }
    if b.count >= 3 && b[0] == 255 && b[1] == 216 && b[2] == 255 { return "image/jpeg" }
    if b.count >= 12 && String(bytes: b[0..<4], encoding: .ascii) == "RIFF" && String(bytes: b[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
    try fail("unsupported-image", "仅支持实际PNG、JPEG与WebP原件")
}
func validatePNGPixelStream(_ bytes: [UInt8], compressed: Data) throws {
    guard bytes.count >= 33, Array(bytes[12..<16]) == [73,72,68,82] else { try fail("decode-failed", "PNG图片缺少有效头部") }
    func be32(_ offset: Int) -> Int { Int(bytes[offset]) << 24 | Int(bytes[offset+1]) << 16 | Int(bytes[offset+2]) << 8 | Int(bytes[offset+3]) }
    let width = be32(16), height = be32(20), depth = Int(bytes[24]), color = bytes[25]
    guard width > 0, height > 0 else { try fail("decode-failed", "PNG图片尺寸无效") }
    guard width <= maximumDimension, height <= maximumDimension, width <= maximumPixels / height else { try fail("pixel-limit", "图片尺寸超过6000万像素或单边50000像素上限") }
    let channels: Int
    switch color { case 0,3: channels = 1; case 2: channels = 3; case 4: channels = 2; case 6: channels = 4; default: try fail("decode-failed", "PNG图片颜色格式无效") }
    guard (color == 0 ? [1,2,4,8,16] : color == 3 ? [1,2,4,8] : [8,16]).contains(depth),
          bytes[26] == 0, bytes[27] == 0, bytes[28] <= 1, !compressed.isEmpty else { try fail("decode-failed", "PNG图片编码格式无效") }
    let passes = bytes[28] == 0 ? [(0,0,1,1)] : [(0,0,8,8),(4,0,8,8),(0,4,4,8),(2,0,4,4),(0,2,2,4),(1,0,2,2),(0,1,1,2)]
    var filters = [Int](), expected = 0
    for (x,y,dx,dy) in passes {
        let pw = max(0, (width - x + dx - 1) / dx), ph = max(0, (height - y + dy - 1) / dy)
        if pw == 0 || ph == 0 { continue }
        let stride = (pw * channels * depth + 7) / 8 + 1
        for row in 0..<ph { filters.append(expected + row * stride) }
        expected += ph * stride
    }
    guard expected <= maximumPixels * 8 + maximumDimension * 7 else { try fail("pixel-limit", "PNG图片展开数据超过上限") }
    // Validate zlib checksum, exact scanline byte count and filter markers with
    // a 64KiB output buffer. ImageIO otherwise accepts a broken IDAT as a blank
    // image, which would incorrectly turn corruption into a no-text result.
    var stream = z_stream(), code: Int32 = Z_OK, total = 0, filterIndex = 0
    guard inflateInit_(&stream, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { try fail("decode-failed", "PNG像素校验器无法初始化") }
    defer { inflateEnd(&stream) }
    try compressed.withUnsafeBytes { input in
        stream.next_in = UnsafeMutablePointer<Bytef>(mutating: input.baseAddress!.assumingMemoryBound(to: Bytef.self))
        stream.avail_in = uInt(compressed.count)
        var output = [UInt8](repeating: 0, count: 65_536)
        try output.withUnsafeMutableBytes { target in
            repeat {
                stream.next_out = target.baseAddress!.assumingMemoryBound(to: Bytef.self); stream.avail_out = 65_536
                code = inflate(&stream, Z_NO_FLUSH)
                let produced = 65_536 - Int(stream.avail_out)
                guard code == Z_OK || code == Z_STREAM_END, total + produced <= expected else { try fail("decode-failed", "PNG压缩像素流损坏或展开长度异常") }
                while filterIndex < filters.count && filters[filterIndex] < total + produced {
                    guard target[filters[filterIndex] - total] <= 4 else { try fail("decode-failed", "PNG像素行过滤器无效") }
                    filterIndex += 1
                }
                total += produced
                if code != Z_STREAM_END && produced == 0 && stream.avail_in == 0 { try fail("decode-failed", "PNG压缩像素流被截断") }
            } while code != Z_STREAM_END
        }
        guard stream.avail_in == 0, total == expected, filterIndex == filters.count else { try fail("decode-failed", "PNG像素流与完整图片尺寸不符") }
    }
}
// ImageIO intentionally tolerates some incomplete streams (notably JPEGs
// without EOI). Require a structurally complete encoded container as well as a
// full pixel materialization; neither a header nor a tolerant decoder suffices.
func validateContainer(_ data: Data, mime: String) throws {
    let bytes = [UInt8](data)
    func be32(_ offset: Int) -> Int { Int(bytes[offset]) << 24 | Int(bytes[offset+1]) << 16 | Int(bytes[offset+2]) << 8 | Int(bytes[offset+3]) }
    func le32(_ offset: Int) -> Int { Int(bytes[offset]) | Int(bytes[offset+1]) << 8 | Int(bytes[offset+2]) << 16 | Int(bytes[offset+3]) << 24 }
    if mime == "image/png" {
        let table: [UInt32] = (0..<256).map { number in
            var crc = UInt32(number)
            for _ in 0..<8 { crc = crc & 1 == 1 ? (crc >> 1) ^ 0xedb88320 : crc >> 1 }
            return crc
        }
        var offset = 8, ended = false, compressed = Data()
        while offset + 12 <= bytes.count {
            let length = be32(offset)
            guard length >= 0, length <= bytes.count - offset - 12 else { try fail("decode-failed", "PNG图片数据块被截断") }
            var crc: UInt32 = 0xffffffff
            for byte in bytes[(offset+4)..<(offset+8+length)] {
                crc = table[Int((crc ^ UInt32(byte)) & 255)] ^ (crc >> 8)
            }
            guard Int(crc ^ 0xffffffff) == be32(offset+8+length) else { try fail("decode-failed", "PNG图片数据块校验失败") }
            let chunk = Array(bytes[(offset+4)..<(offset+8)])
            if chunk == [73,68,65,84] { compressed.append(contentsOf: bytes[(offset+8)..<(offset+8+length)]) }
            let isEnd = chunk == [73,69,78,68]
            offset += length + 12
            if isEnd { guard length == 0 else { try fail("decode-failed", "PNG结束块无效") }; ended = true; break }
        }
        guard ended else { try fail("decode-failed", "PNG图片数据未完整结束") }
        try validatePNGPixelStream(bytes, compressed: compressed)
    } else if mime == "image/jpeg" {
        var offset = 2, foundScan = false, ended = false
        while offset < bytes.count {
            guard bytes[offset] == 255 else { try fail("decode-failed", "JPEG图片标记损坏") }
            while offset < bytes.count && bytes[offset] == 255 { offset += 1 }
            guard offset < bytes.count else { break }
            let marker = bytes[offset]; offset += 1
            if marker == 0xd9 { ended = foundScan; break }
            if marker == 0x01 || (0xd0...0xd7).contains(marker) { continue }
            guard offset + 2 <= bytes.count else { break }
            let length = Int(bytes[offset]) << 8 | Int(bytes[offset+1])
            guard length >= 2, length <= bytes.count - offset else { try fail("decode-failed", "JPEG图片数据段被截断") }
            offset += length
            if marker == 0xda {
                foundScan = true
                // Skip byte stuffing and restart markers inside entropy data;
                // metadata bytes containing FF D9 are not image completion.
                while offset < bytes.count {
                    if bytes[offset] != 255 { offset += 1; continue }
                    let markerStart = offset
                    while offset < bytes.count && bytes[offset] == 255 { offset += 1 }
                    if offset >= bytes.count { break }
                    let next = bytes[offset]
                    if next == 0 || (0xd0...0xd7).contains(next) { offset += 1; continue }
                    offset = markerStart; break
                }
            }
        }
        guard ended else { try fail("decode-failed", "JPEG图片像素流缺少完整结束标记") }
    } else if mime == "image/webp" {
        guard bytes.count >= 12, le32(4) >= 4, le32(4) <= bytes.count - 8 else { try fail("decode-failed", "WebP图片容器被截断") }
        let end = le32(4) + 8; var offset = 12
        while offset + 8 <= end {
            let length = le32(offset+4)
            guard length >= 0, length <= end - offset - 8 else { try fail("decode-failed", "WebP图片数据块被截断") }
            offset += 8 + length + length % 2
        }
        guard offset == end else { try fail("decode-failed", "WebP图片数据块不完整") }
    }
}
func orientationMatrix(_ orientation: Int) -> [Int] {
    // [a,b,c,d,tx,ty], rawX=a*displayX+c*displayY+tx, rawY=b*displayX+d*displayY+ty.
    switch orientation {
    case 2: return [-1,0,0,1,1,0]
    case 3: return [-1,0,0,-1,1,1]
    case 4: return [1,0,0,-1,0,1]
    case 5: return [0,1,1,0,0,0]
    case 6: return [0,-1,1,0,0,1]
    case 7: return [0,-1,-1,0,1,1]
    case 8: return [0,1,-1,0,1,0]
    default: return [1,0,0,1,0,0]
    }
}
func decode(_ input: [String: Any]) throws -> (CGImage, [String: Any]) {
    let (bytes, sha) = try safeInput(input), mime = try mimeType(bytes)
    try validateContainer(bytes, mime: mime)
    if let expected = input["expectedMime"] as? String, expected != mime { try fail("input-mismatch", "固定图片类型已变化") }
    guard let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          CGImageSourceGetCount(source) == 1,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let rawWidth = integer(properties[kCGImagePropertyPixelWidth]), let rawHeight = integer(properties[kCGImagePropertyPixelHeight]), rawWidth > 0, rawHeight > 0 else { try fail("decode-failed", "图片原件损坏、无法解码或不是单帧图片") }
    guard rawWidth <= maximumDimension, rawHeight <= maximumDimension, rawWidth <= maximumPixels / rawHeight else { try fail("pixel-limit", "图片尺寸超过6000万像素或单边50000像素上限") }
    let imageIOOrientation = integer(properties[kCGImagePropertyOrientation])
    if let reported = imageIOOrientation, !(1...8).contains(reported) {
        try fail("metadata-incompatible", "ImageIO返回无法解释的图片方向；原件保留，请重新消化或报告兼容问题")
    }
    let orientation = imageIOOrientation ?? 1
    let width = orientation >= 5 ? rawHeight : rawWidth, height = orientation >= 5 ? rawWidth : rawHeight
    for (key, actual) in [("expectedWidth", width), ("expectedHeight", height), ("expectedOrientation", orientation)] {
        if let expected = input[key], integer(expected) != actual { try fail("input-mismatch", "固定图片尺寸或方向已变化") }
    }
    // ImageIO applies all eight EXIF transforms at full original resolution.
    // This is not the application's 256px display thumbnail.
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: max(rawWidth, rawHeight),
        kCGImageSourceShouldCacheImmediately: true]
    guard CGImageSourceGetStatus(source) == .statusComplete,
          let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary), decoded.width == width, decoded.height == height else { try fail("decode-failed", "图片方向归一化全分辨率解码失败") }
    // Creating a CGImage can be lazy. Materialize every pixel before declaring
    // inspect successful; a readable header is not evidence of readable pixels.
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { try fail("decode-failed", "图片全分辨率像素缓冲无法建立") }
    context.draw(decoded, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
          context.makeImage() != nil else { try fail("decode-failed", "图片原件像素不完整或损坏") }
    // The materialization is a validation side effect. OCR keeps ImageIO's
    // normalized original pixels; a second color-space conversion is not an OCR
    // preprocessing step and must not introduce a different recognition input.
    let image = decoded
    guard residentPeak() < maximumObservedResidentBytes else { try fail("memory-limit", "图片全分辨率解码内存观测超过1GiB边界") }
    guard image.bitsPerPixel <= 64, image.bytesPerRow <= (maximumPixels * 8) / image.height else { try fail("pixel-limit", "图片解码存储超过上限") }
    var normalization: [String: Any] = ["policyVersion": normalizationPolicy,
        "basis": imageIOOrientation == nil ? "imageio-default-after-full-decode" : "imageio-validated-orientation", "decode": "full-resolution"]
    if let reported = imageIOOrientation { normalization["imageIOOrientation"] = reported }
    return (image, ["sha256": sha, "bytes": bytes.count, "mime": mime, "rawWidth": rawWidth, "rawHeight": rawHeight,
        "width": width, "height": height, "orientation": orientation,
        "normalization": normalization,
        "orientationTransform": ["normalizedDisplayToRaw": orientationMatrix(orientation), "unit": "normalized", "displayOrigin": "top-left", "rawOrigin": "top-left"]])
}

struct OCRCandidate {
    let id: String
    let text: String
    let rectangle: CGRect
    let confidence: Float
    let sliceId: String
    let edgeDistancePx: CGFloat
}
struct OCRLine {
    var selected: OCRCandidate
    var candidates: [OCRCandidate]
    var reason: String
    var text: String { selected.text }
    var rectangle: CGRect { selected.rectangle }
    var confidence: Float { selected.confidence }
    var sliceIds: [String] { Array(Set(candidates.map { $0.sliceId })).sorted() }
    var conflict: Bool { Set(candidates.map { $0.text.filter { !$0.isWhitespace } }).count > 1 }
}
struct Slice { let id: String; let rectangle: CGRect }
func tileStarts(_ dimension: Int, size: Int) -> [Int] {
    if dimension <= size { return [0] }
    let intervals = Int(ceil(Double(dimension - size) / Double(size - overlap)))
    // Even spacing preserves at least the configured overlap and avoids a final
    // almost-identical tile for dimensions just beyond an earlier last edge.
    return (0...intervals).map { Int((Double(dimension - size) * Double($0) / Double(intervals)).rounded()) }
}
func plannedSlices(_ width: Int, _ height: Int) -> [Slice] {
    guard width <= maximumOcrWidth else { return [] }
    if max(width, height) <= wholeImageMaximumDimension && width <= wholeImageMaximumPixels / height {
        return [Slice(id: "slice-0", rectangle: CGRect(x: 0, y: 0, width: width, height: height))]
    }
    // A horizontal crop can give two incomplete readings of the same long line.
    // Avoid that ambiguity rather than concatenating or deleting unknown words:
    // retain the full width, bound each vertical strip to 12M source pixels.
    let stripHeight = min(tileHeight, maximumTilePixels / width)
    return tileStarts(height, size: stripHeight).enumerated().map { index, y in
        Slice(id: "slice-\(index)", rectangle: CGRect(x: 0, y: y, width: width, height: min(stripHeight, height - y)))
    }
}
func sameSpatialObservation(_ a: OCRCandidate, _ b: OCRCandidate, slices: [Slice]) -> Bool {
    guard a.sliceId != b.sliceId,
          let ar = slices.first(where: { $0.id == a.sliceId })?.rectangle,
          let br = slices.first(where: { $0.id == b.sliceId })?.rectangle else { return false }
    let overlapArea = ar.intersection(br), intersection = a.rectangle.intersection(b.rectangle)
    let sharedPixels = overlapArea.intersection(intersection)
    guard !overlapArea.isNull, overlapArea.width > 0, overlapArea.height > 0,
          !intersection.isNull, intersection.width > 0, intersection.height > 0,
          !sharedPixels.isNull, sharedPixels.width > 0, sharedPixels.height > 0 else { return false }
    let smallerArea = min(a.rectangle.width * a.rectangle.height, b.rectangle.width * b.rectangle.height)
    let smallerHeight = min(a.rectangle.height, b.rectangle.height)
    // Containment includes a truncated/discordant candidate. Text similarity is
    // deliberately not required: two readings of the same pixels are one line.
    return intersection.width * intersection.height / smallerArea >= 0.60
        && intersection.height / smallerHeight >= 0.65
        && abs(a.rectangle.midY - b.rectangle.midY) <= max(2, max(a.rectangle.height, b.rectangle.height) * 0.45)
}
func preference(_ a: OCRCandidate, _ b: OCRCandidate) -> (Bool, String) {
    let aComplete = a.edgeDistancePx >= max(4, a.rectangle.height * 0.5)
    let bComplete = b.edgeDistancePx >= max(4, b.rectangle.height * 0.5)
    if aComplete != bComplete { return (aComplete, "interior-margin-before-confidence") }
    // Prefer the observed, less-truncated spatial extent, never synthesize text.
    let aa = a.rectangle.width * a.rectangle.height, ba = b.rectangle.width * b.rectangle.height
    if aa != ba { return (aa > ba, "larger-observed-region") }
    if a.confidence != b.confidence { return (a.confidence > b.confidence, "confidence-tie-break-not-accuracy") }
    return (a.id < b.id, "stable-candidate-id")
}
func mergedLines(_ candidates: [OCRCandidate], slices: [Slice]) -> [OCRLine] {
    var lines = [OCRLine]()
    for candidate in candidates {
        let matches = lines.indices.filter { index in
            lines[index].candidates.contains(where: { sameSpatialObservation($0, candidate, slices: slices) })
        }
        if matches.isEmpty {
            lines.append(OCRLine(selected: candidate, candidates: [candidate], reason: "single-observation"))
        } else {
            // One complete observation can match several clipped fragments from
            // another tile. Merge all matching groups rather than leaving a
            // second fragment duplicated below the selected full observation.
            let alternatives = matches.flatMap { lines[$0].candidates } + [candidate]
            var selected = alternatives[0], reason = "single-observation"
            for next in alternatives.dropFirst() {
                let (replace, basis) = preference(next, selected)
                if replace { selected = next; reason = basis }
            }
            reason = "lexicographic-interior-margin-region-area-confidence-id"
            let merged = OCRLine(selected: selected, candidates: alternatives.sorted { $0.id < $1.id }, reason: reason)
            let insertion = matches[0]
            for index in matches.reversed() { lines.remove(at: index) }
            lines.insert(merged, at: insertion)
        }
    }
    return lines
}
func median(_ values: [CGFloat]) -> CGFloat {
    let sorted = values.sorted(); return sorted[sorted.count / 2]
}
func readingOrder(_ lines: [OCRLine]) -> [(OCRLine, Int, CGFloat)] {
    var rows = [[OCRLine]]()
    let stable = lines.sorted {
        if $0.rectangle.minY != $1.rectangle.minY { return $0.rectangle.minY < $1.rectangle.minY }
        if $0.rectangle.minX != $1.rectangle.minX { return $0.rectangle.minX < $1.rectangle.minX }
        return $0.selected.id < $1.selected.id
    }
    for line in stable {
        var match: Int?, distance = CGFloat.greatestFiniteMagnitude
        for (index, row) in rows.enumerated() {
            let baseline = median(row.map { $0.rectangle.maxY }), height = median(row.map { $0.rectangle.height })
            let delta = abs(line.rectangle.maxY - baseline)
            let tolerance = max(2, min(height, line.rectangle.height) * 0.42)
            let centerDelta = abs(line.rectangle.midY - median(row.map { $0.rectangle.midY }))
            if delta <= tolerance && centerDelta <= max(height, line.rectangle.height) * 0.60 && delta < distance {
                match = index; distance = delta
            }
        }
        if let index = match { rows[index].append(line) } else { rows.append([line]) }
    }
    rows.sort {
        let a = median($0.map { $0.rectangle.maxY }), b = median($1.map { $0.rectangle.maxY })
        if a != b { return a < b }
        return $0[0].selected.id < $1[0].selected.id
    }
    return rows.enumerated().flatMap { index, row in
        let baseline = median(row.map { $0.rectangle.maxY })
        return row.sorted {
            if $0.rectangle.minX != $1.rectangle.minX { return $0.rectangle.minX < $1.rectangle.minX }
            return $0.selected.id < $1.selected.id
        }.map { ($0, index, baseline) }
    }
}
func normalizedBounds(_ rectangle: CGRect, width: Int, height: Int) -> [String: Any] {
    let x = rectangle.minX / CGFloat(width), y = rectangle.minY / CGFloat(height)
    return ["x": x, "y": y, "width": min(1 - x, rectangle.width / CGFloat(width)),
        "height": min(1 - y, rectangle.height / CGFloat(height)), "unit": "normalized"]
}
func recognize(_ image: CGImage, engine: [String: Any]) throws -> [String: Any] {
    let startedAt = ISO8601DateFormatter().string(from: Date())
    let deadline = Date().addingTimeInterval(88)
    guard image.width <= maximumOcrWidth else { try fail("tile-limit", "图片识别宽度超过8192像素上限；原件保留，不缩小或横向截断文字") }
    let slices = plannedSlices(image.width, image.height)
    guard slices.count <= maximumTiles else { try fail("tile-limit", "图片需要的切片数量超过64片上限") }
    var candidates = [OCRCandidate](), statuses = [[String: Any]](), failures = 0, totalObservations = 0
    for slice in slices {
        var status: [String: Any] = ["id":slice.id, "x":Int(slice.rectangle.minX), "y":Int(slice.rectangle.minY), "width":Int(slice.rectangle.width), "height":Int(slice.rectangle.height)]
        do {
            try autoreleasepool {
                guard Date() < deadline else { try fail("timeout", "图片切片识别超过处理时限") }
                guard residentPeak() < maximumObservedResidentBytes else { try fail("memory-limit", "图片识别进程内存观测超过1GiB边界") }
                #if OCR_HELPER_TESTING
                if ProcessInfo.processInfo.environment["RLW_OCR_TEST_FAIL_SLICE"] == slice.id { try fail("slice-failed", "仅测试构建注入的单切片失败") }
                #endif
                guard let tile = image.cropping(to: slice.rectangle) else { try fail("slice-failed", "原图切片解码失败") }
                let request = VNRecognizeTextRequest()
                request.revision = engine["revision"] as! Int; request.recognitionLevel = .accurate
                request.recognitionLanguages = engine["languages"] as! [String]
                request.usesLanguageCorrection = true; request.minimumTextHeight = 0; request.automaticallyDetectsLanguage = false
                do { try VNImageRequestHandler(cgImage: tile, orientation: .up).perform([request]) }
                catch { try fail("recognition-failed", "Apple Vision 切片文字识别失败") }
                guard residentPeak() < maximumObservedResidentBytes else { try fail("memory-limit", "图片识别进程内存观测超过1GiB边界") }
                totalObservations += request.results?.count ?? 0
                guard totalObservations <= maximumBlocks * 4 else { try fail("output-limit", "原始切片文字区域数量超过上限") }
                for (observationIndex, observation) in (request.results ?? []).enumerated() {
                    guard let candidate = observation.topCandidates(1).first, !candidate.string.isEmpty else { continue }
                    let r = observation.boundingBox
                    let local = CGRect(x: max(0, r.minX) * slice.rectangle.width, y: max(0, 1 - r.maxY) * slice.rectangle.height,
                        width: min(1, r.maxX) * slice.rectangle.width - max(0, r.minX) * slice.rectangle.width,
                        height: min(1, 1 - r.minY) * slice.rectangle.height - max(0, 1 - r.maxY) * slice.rectangle.height)
                    guard [local.minX,local.minY,local.width,local.height].allSatisfy({ $0.isFinite }), local.width > 0, local.height > 0 else { try fail("invalid-regions", "识别返回无效图片区域") }
                    let rectangle = local.offsetBy(dx: slice.rectangle.minX, dy: slice.rectangle.minY)
                    var distances = [CGFloat]()
                    if slice.rectangle.minX > 0 { distances.append(rectangle.minX - slice.rectangle.minX) }
                    if slice.rectangle.minY > 0 { distances.append(rectangle.minY - slice.rectangle.minY) }
                    if slice.rectangle.maxX < CGFloat(image.width) { distances.append(slice.rectangle.maxX - rectangle.maxX) }
                    if slice.rectangle.maxY < CGFloat(image.height) { distances.append(slice.rectangle.maxY - rectangle.maxY) }
                    candidates.append(OCRCandidate(id: "\(slice.id)-observation-\(observationIndex)", text: candidate.string,
                        rectangle: rectangle, confidence: candidate.confidence, sliceId: slice.id,
                        edgeDistancePx: max(0, distances.min() ?? CGFloat(max(image.width, image.height)))))
                }
            }
            status["status"] = "succeeded"
        } catch let error as HelperError {
            if error.code == "output-limit" || error.code == "invalid-regions" || error.code == "memory-limit" { throw error }
            failures += 1; status["status"] = "failed"; status["error"] = ["code":error.code,"message":error.message]
        } catch {
            failures += 1; status["status"] = "failed"; status["error"] = ["code":"slice-failed","message":"图片切片识别失败"]
        }
        statuses.append(status)
    }
    guard failures < slices.count else { try fail("recognition-failed", "图片所有切片识别失败") }
    let lines = mergedLines(candidates, slices: slices)
    guard lines.count <= maximumBlocks else { try fail("output-limit", "文字区域数量超过上限") }
    let sorted = readingOrder(lines)
    var blocks = [[String: Any]](), texts = [String]()
    for (line, row, baseline) in sorted {
        let x = line.rectangle.minX / CGFloat(image.width), y = line.rectangle.minY / CGFloat(image.height)
        let width = min(1 - x, line.rectangle.width / CGFloat(image.width)), height = min(1 - y, line.rectangle.height / CGFloat(image.height))
        guard [x,y,width,height].allSatisfy({ $0.isFinite }), width > 0, height > 0 else { try fail("invalid-regions", "识别返回无效图片区域") }
        let order = blocks.count
        let alternatives: [[String: Any]] = line.candidates.map { candidate in
            ["id": candidate.id, "text": candidate.text,
                "bounds": normalizedBounds(candidate.rectangle, width: image.width, height: image.height),
                "confidence": candidate.confidence, "sliceId": candidate.sliceId,
                "edgeDistancePx": candidate.edgeDistancePx, "selected": candidate.id == line.selected.id]
        }
        blocks.append(["id": "line-\(order)", "text": line.text, "bounds": ["x":x,"y":y,"width":width,"height":height,"unit":"normalized"], "order": order, "confidence": line.confidence, "sliceIds": line.sliceIds,
            "provenance": ["selectedId": line.selected.id, "candidates": alternatives, "conflict": line.conflict,
                "mergePolicy": mergePolicy, "selectionReason": line.reason, "row": row, "baselinePx": baseline]])
        texts.append(line.text)
    }
    let text = texts.joined(separator: "\n")
    guard text.unicodeScalars.count <= maximumTextCodePoints else { try fail("output-limit", "识别文字长度超过上限") }
    var warnings = ["识别区域为行或片段；复杂排版与识别文字需核对，置信度不代表准确率"]
    if slices.count > 1 { warnings.append("原分辨率全宽重叠纵向条带；同位置候选仅保留一份正文，原始候选与接缝仍需核对") }
    let conflicts = lines.filter { $0.conflict }.count
    if conflicts > 0 { warnings.append("\(conflicts)个位置存在不同切片识别冲突，已保留候选供核对；选择不等于人工校对") }
    if failures > 0 { warnings.append("部分切片失败，已保存文字仅代表部分图片覆盖，不能视为识别完成") }
    return ["text": text, "blocks": blocks, "slices": statuses,
        "quality": ["execution": failures > 0 ? "partial" : "complete", "review": "required", "conflictBlocks": conflicts],
        "coverage": failures > 0 ? "partial" : (text.isEmpty ? "no-text" : "complete"), "warnings": warnings,
        "startedAt": startedAt, "completedAt": ISO8601DateFormatter().string(from: Date())]
}

#if OCR_HELPER_TESTING
// Fixed synthetic geometry checks execute the same production merge/order
// functions. No injected candidates are accepted by the production protocol.
func mechanismChecks() -> [[String: Any]] {
    let slices = [Slice(id: "left", rectangle: CGRect(x:0,y:0,width:2048,height:3072)),
        Slice(id: "right", rectangle: CGRect(x:1792,y:0,width:2048,height:3072)),
        Slice(id: "bottom", rectangle: CGRect(x:0,y:2816,width:2048,height:3072))]
    func c(_ id: String, _ text: String, _ rect: CGRect, _ slice: String, _ margin: CGFloat = 40, _ confidence: Float = 0.9) -> OCRCandidate {
        OCRCandidate(id:id,text:text,rectangle:rect,confidence:confidence,sliceId:slice,edgeDistancePx:margin)
    }
    var result = [[String: Any]]()
    func check(_ name: String, _ passed: Bool) { result.append(["name":name,"passed":passed]) }
    let full = c("full", "THE COMPLETE ORIGINAL LINE", CGRect(x:1800,y:100,width:380,height:40), "right")
    let cut = c("cut", "THE COMPLET", CGRect(x:1800,y:100,width:240,height:40), "left", 0, 0.99)
    let horizontal = mergedLines([cut,full],slices:slices)
    check("same-position horizontal truncated candidate keeps one full observation", horizontal.count == 1 && horizontal[0].text == full.text && horizontal[0].candidates.count == 2 && horizontal[0].conflict)
    let discordant = c("discordant", "THE C0MPLETE ORIGINAL LINE", full.rectangle, "left", 40, 0.85)
    let mismatch = mergedLines([full,discordant],slices:slices)
    check("same-position discordant candidates retained but not duplicated in text", mismatch.count == 1 && mismatch[0].text == full.text && mismatch[0].candidates.count == 2 && mismatch[0].conflict)
    let fragmentA = c("fragment-a", "PART ONE", CGRect(x:1800,y:100,width:110,height:40), "left", 0)
    let fragmentB = c("fragment-b", "PART TWO", CGRect(x:1920,y:100,width:120,height:40), "left", 0)
    let fragments = mergedLines([fragmentA,fragmentB,full],slices:slices)
    check("one full observation absorbs all matching cross-tile fragments", fragments.count == 1 && fragments[0].text == full.text && fragments[0].candidates.count == 3)
    let repeatA = c("repeat-a", "REPEATED", CGRect(x:1800,y:200,width:200,height:40), "left")
    let repeatB = c("repeat-b", "REPEATED", CGRect(x:1800,y:400,width:200,height:40), "right")
    check("identical text at different positions survives", mergedLines([repeatA,repeatB],slices:slices).count == 2)
    let vf = c("vertical-full", "VERTICAL SEAM FULL", CGRect(x:80,y:2820,width:500,height:40), "bottom")
    let vc = c("vertical-cut", "VERTICAL SEAM FUL", CGRect(x:80,y:2840,width:500,height:20), "left", 0, 0.99)
    let vertical = mergedLines([vc,vf],slices:slices)
    check("vertical seam truncated candidate keeps complete observed line", vertical.count == 1 && vertical[0].text == vf.text)
    let nonoverlap = [Slice(id:"left",rectangle:CGRect(x:0,y:0,width:2048,height:3072)),Slice(id:"right",rectangle:CGRect(x:2048,y:0,width:2048,height:3072))]
    check("physical slice overlap required", mergedLines([full,discordant],slices:nonoverlap).count == 2)
    let boundary = [c("boundary-right","RIGHT",CGRect(x:500,y:9,width:200,height:20),"left"),c("boundary-left","LEFT",CGRect(x:50,y:7,width:200,height:20),"left")]
    check("same visual row across old 8px boundary reads left then right", readingOrder(mergedLines(boundary,slices:slices)).map{$0.0.text} == ["LEFT","RIGHT"])
    let fonts = [c("large","LARGE",CGRect(x:50,y:20,width:200,height:40),"left"),c("small","SMALL",CGRect(x:500,y:38,width:200,height:20),"left"),c("next","NEXT",CGRect(x:50,y:86,width:200,height:20),"left")]
    let ordered = readingOrder(mergedLines(fonts.reversed(),slices:slices))
    check("font-relative baselines retain mixed-size visual row", ordered.map{$0.0.text} == ["LARGE","SMALL","NEXT"] && ordered[0].1 == ordered[1].1 && ordered[2].1 != ordered[0].1)
    check("order is stable under candidate input permutation", readingOrder(mergedLines(fonts,slices:slices)).map{$0.0.text} == ordered.map{$0.0.text})
    check("moderate 2560x1440 image is one complete tile", plannedSlices(2560,1440).count == 1)
    let tiles = plannedSlices(1400,8500)
    check("long-image tile coverage and minimum overlap", tiles.count == 3 && tiles.first?.rectangle.minY == 0 && tiles.last?.rectangle.maxY == 8500 && zip(tiles,tiles.dropFirst()).allSatisfy{$0.rectangle.maxY-$1.rectangle.minY >= CGFloat(overlap)})
    let oldLeft = c("old-left", "LEFT PART WITH OVERLAP", CGRect(x:500,y:100,width:1548,height:40), "left", 0)
    let oldRight = c("old-right", "OVERLAP WITH RIGHT PART", CGRect(x:1792,y:100,width:1708,height:40), "right", 0)
    check("old dual-clipped horizontal geometry is not falsely claimed merged", mergedLines([oldLeft,oldRight],slices:slices).count == 2)
    let wide = plannedSlices(5000,6000)
    check("wide-image production strips have no horizontal seam", wide.count > 1 && wide.allSatisfy{$0.rectangle.minX == 0 && $0.rectangle.width == 5000 && $0.rectangle.width * $0.rectangle.height <= CGFloat(maximumTilePixels)})
    check("8193px width is explicitly outside OCR resource scope", plannedSlices(8193,1000).isEmpty)
    check("mirror display-to-raw coordinate matrix", orientationMatrix(2) == [-1,0,0,1,1,0] && orientationMatrix(7) == [0,-1,-1,0,1,1])
    return result
}
#endif

do {
    let processStarted = Date()
    let inputData = FileHandle.standardInput.readData(ofLength: 65_537)
    guard !inputData.isEmpty, inputData.count <= 65_536 else { try fail("invalid-input", "helper请求为空或超过64KiB") }
    let value = try JSONSerialization.jsonObject(with: inputData)
    let request = try object(value, allowed: ["schemaVersion","op","input","config"], name: "helper请求")
    var operations = ["probe","inspect","recognize"]
    #if OCR_HELPER_TESTING
    operations.append("mechanism-checks")
    #endif
    guard integer(request["schemaVersion"]) == 1, let op = request["op"] as? String, operations.contains(op) else { try fail("invalid-input", "helper请求版本或操作无效") }
    let config = try object(request["config"] ?? [String: Any](), allowed: ["languages","revision"], name: "OCR配置")
    let engine = try engineInfo(config)
    var response: [String: Any] = ["schemaVersion":1,"ok":true,"op":op,"engine":engine,"limits":limits]
    if op == "probe" || op == "mechanism-checks" {
        guard request["input"] == nil else { try fail("invalid-input", "能力探测不接受图片输入") }
        #if OCR_HELPER_TESTING
        if op == "mechanism-checks" { response["checks"] = mechanismChecks() }
        #endif
    } else {
        let input = try object(request["input"], allowed: ["root","relativePath","expectedSha256","expectedBytes","expectedMime","expectedWidth","expectedHeight","expectedOrientation"], name: "固定图片")
        if op == "recognize" {
            guard let sha = input["expectedSha256"] as? String, sha.count == 64, sha.allSatisfy({ "0123456789abcdef".contains($0) }),
                  integer(input["expectedBytes"]) != nil, input["expectedMime"] is String else { try fail("invalid-input", "识别必须提供已冻结的字节摘要、大小和类型") }
        }
        let (image, metadata) = try decode(input); response["image"] = metadata
        if op == "recognize" { response["recognition"] = try recognize(image, engine: engine) }
    }
    response["metrics"] = ["elapsedMs": Int(Date().timeIntervalSince(processStarted) * 1000), "peakResidentBytes": residentPeak(),
        "memoryMethod": "getrusage(RUSAGE_SELF).ru_maxrss; macOS bytes; helper process only"]
    emit(response)
} catch let error as HelperError {
    emit(["schemaVersion":1,"ok":false,"error":["code":error.code,"message":error.message]], exitCode: 1)
} catch {
    emit(["schemaVersion":1,"ok":false,"error":["code":"helper-failed","message":"本地图片识别 helper 执行失败"]], exitCode: 1)
}

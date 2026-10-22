import Foundation
import AppKit
import ImageIO
import UniformTypeIdentifiers
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory:true)
let font = NSFont.systemFont(ofSize:44, weight:.medium)
func canvas(_ width:Int,_ height:Int,_ rows:[(String,Int)]) -> CGImage {
 let context = CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
 context.setFillColor(CGColor(gray:1,alpha:1));context.fill(CGRect(x:0,y:0,width:width,height:height))
 NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(cgContext:context,flipped:false)
 for (text,y) in rows { (text as NSString).draw(at:NSPoint(x:80,y:height-y-60),withAttributes:[.font:font,.foregroundColor:NSColor.black]) }
 NSGraphicsContext.restoreGraphicsState();return context.makeImage()!
}
func encoded(_ image:CGImage,_ type:UTType,_ orientation:Int=1)->Data {
 let data=NSMutableData();let destination=CGImageDestinationCreateWithData(data,type.identifier as CFString,1,nil)!
 CGImageDestinationAddImage(destination,image,[kCGImagePropertyOrientation:orientation,kCGImageDestinationLossyCompressionQuality:1] as CFDictionary)
 precondition(CGImageDestinationFinalize(destination));return data as Data
}
let baseRows=[("ORIENTATION CHECK ALPHA",100),("TOP LEFT TEXT BRAVO",300),("CENTER MARKER CHARLIE",500),("BOTTOM LINE DELTA 12345",700)]
let base=canvas(1400,1000,baseRows);try encoded(base,.png).write(to:root.appendingPathComponent("orientation-reference.png"))
let inverses=[1,2,3,4,5,8,7,6]
for o in 1...8 {
 let source=CGImageSourceCreateWithData(encoded(base,.tiff,inverses[o-1]) as CFData,nil)!
 let raw=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:1400] as CFDictionary)!
 try encoded(raw,.jpeg,o).write(to:root.appendingPathComponent("orientation-\(o).jpg"))
}
var longRows=[(String,Int)]()
for i in 0..<46 { longRows.append(("ROW \(String(format:"%02d",i)) LONG IMAGE CHECK \(1000+i)",40+i*180)) }
longRows.append(("REPEATED PARAGRAPH ALPHA",2850));longRows.append(("REPEATED PARAGRAPH ALPHA",6250))
longRows.append(("OVERLAP SEAM MUST SURVIVE",3010));longRows.append(("SECOND SEAM MUST SURVIVE",5890))
longRows.sort{$0.1<$1.1}
let long=canvas(1400,8500,longRows);try encoded(long,.png).write(to:root.appendingPathComponent("long-seams.png"))
try encoded(canvas(900,700,[]),.png).write(to:root.appendingPathComponent("blank.png"))
let refs:[String:Any]=["synthetic":true,"orientation":baseRows.map{["text":$0.0,"y":$0.1]},"long":longRows.map{["text":$0.0,"y":$0.1]}]
try JSONSerialization.data(withJSONObject:refs,options:[.prettyPrinted,.sortedKeys]).write(to:root.appendingPathComponent("references.json"))
print("synthetic base fixture count=15; orientation variants=8; long lines=\(longRows.count)")
// Development-only synthetic fixtures. Not an OCR runtime or real-quality data.
// Run by scripts/check-ocr-helper.mjs inside a fresh ignored acceptance root.

// E1.1.1 synthetic geometry: horizontal clipping plus mixed-size baselines.
func positionedCanvas(_ width:Int,_ height:Int,_ rows:[(String,Int,Int,CGFloat)]) -> CGImage {
 let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
 context.setFillColor(CGColor(gray:1,alpha:1));context.fill(CGRect(x:0,y:0,width:width,height:height))
 NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(cgContext:context,flipped:false)
 for (text,x,y,size) in rows { (text as NSString).draw(at:NSPoint(x:x,y:height-y-60),withAttributes:[.font:NSFont.systemFont(ofSize:size,weight:.medium),.foregroundColor:NSColor.black]) }
 NSGraphicsContext.restoreGraphicsState();return context.makeImage()!
}
let horizontal=positionedCanvas(5000,1400,[("HORIZONTAL SEAM ORIGINAL TEXT 12345",1800,180,44),("REPEATED SEPARATE LINE",1800,440,44),("REPEATED SEPARATE LINE",1800,740,44)])
try encoded(horizontal,.png).write(to:root.appendingPathComponent("horizontal-seams.png"))
let moderate=positionedCanvas(2560,1440,[("COMPLETE MODERATE WIDTH ORIGINAL TITLE",800,180,44),("LEFT ALPHA",80,460,44),("RIGHT BRAVO",900,462,44),("SMALL FONT CHARLIE",80,740,30),("LARGER FONT DELTA",900,730,44)])
try encoded(moderate,.png).write(to:root.appendingPathComponent("moderate-width.png"))

let fullWidthText="FULL WIDTH ORIGINAL ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL INDIA JULIET KILO LIMA MIKE NOVEMBER 12345"
try encoded(positionedCanvas(5000,1400,[(fullWidthText,500,180,44)]),.png).write(to:root.appendingPathComponent("full-width-line.png"))
try encoded(canvas(8193,200,[]),.png).write(to:root.appendingPathComponent("ocr-too-wide.png"))

import { imageInfo,imageMimeSignature } from './editor-media.js';

import type {OcrRawExifOrientation as RawExifOrientation,OcrHeaderMetadata} from '../shared/ocr-contracts.js';
export type {OcrHeaderMetadata} from '../shared/ocr-contracts.js';
/** Header diagnostics only. Tolerant mode never treats EXIF compatibility as pixel damage.
 * Its orientation is advisory; production E1.1.1 uses full ImageIO inspection instead. */
export function ocrImageMetadata(bytes:Buffer,options:{tolerant?:boolean}={}):OcrHeaderMetadata {
  const issues:string[]=[];let info:{mime:string;width:number;height:number};
  try{info=imageInfo(bytes);if(!Number.isSafeInteger(info.width)||!Number.isSafeInteger(info.height)||info.width<=0||info.height<=0)throw new Error('图片像素尺寸无效');}
  catch(error){if(!options.tolerant)throw error;info={mime:imageMimeSignature(bytes),width:0,height:0};issues.push('Node图片头尺寸不可确认；等待ImageIO全分辨率解码，不按缺件处理');}
  const fields:RawExifOrientation[]=[];let orientation=1;
  const issue=(message:string)=>{issues.push(message);if(!options.tolerant)throw new Error(message);};
  const exif=(source:Buffer,container:RawExifOrientation['container'])=>{try{
    let data=source;if(data.subarray(0,6).equals(Buffer.from('Exif\0\0')))data=data.subarray(6);
    if(data.length<8)throw new Error('图片方向元数据截断');
    const endian=data.toString('ascii',0,2),little=endian==='II';if(!little&&endian!=='MM')throw new Error('图片方向字节序无效');
    const u16=(n:number)=>{if(n<0||n+2>data.length)throw new Error('图片方向元数据越界');return little?data.readUInt16LE(n):data.readUInt16BE(n);};
    const u32=(n:number)=>{if(n<0||n+4>data.length)throw new Error('图片方向元数据越界');return little?data.readUInt32LE(n):data.readUInt32BE(n);};
    if(u16(2)!==42)throw new Error('图片方向TIFF标识无效');const start=u32(4),count=u16(start);
    if(count>4096||start+2+count*12>data.length)throw new Error('图片方向字段数量或边界无效');
    for(let i=0;i<count;i++){const at=start+2+i*12;if(u16(at)!==0x112)continue;const type=u16(at+2),count=u32(at+4);let value:number|null=null;
      if(count===1&&type===3)value=u16(at+8);else if(count===1&&type===4)value=u32(at+8);
      const valid=type===3&&count===1&&value!==null&&value>=1&&value<=8;
      const reason=valid?undefined:type!==3?'方向字段不是标准SHORT/type3':count!==1?'方向字段count不是1':value===0?'方向字段为0':value===null?'方向字段无法安全解释':'方向字段不在1–8';
      fields.push({container,type,count,value,offset:at,status:valid?'valid':type===4&&count===1?'nonstandard':'invalid',...(reason?{reason}:{})});
      if(valid)orientation=value!;else issue(reason!);
    }
  }catch(error){issue(error instanceof Error?error.message:'图片方向元数据异常');}};
  try{
    if(info.mime==='image/jpeg'){let at=2;while(at+2<=bytes.length){if(bytes[at++]!==0xff)continue;while(bytes[at]===0xff)at++;const marker=bytes[at++];if(marker===0xda||marker===0xd9)break;if(marker===0xd8||marker===1||(marker>=0xd0&&marker<=0xd7))continue;if(at+2>bytes.length)throw new Error('JPEG元数据截断');const n=bytes.readUInt16BE(at);if(n<2||at+n>bytes.length)throw new Error('JPEG元数据长度无效');if(marker===0xe1&&bytes.subarray(at+2,at+8).equals(Buffer.from('Exif\0\0')))exif(bytes.subarray(at+2,at+n),'jpeg');at+=n;}}
    else if(info.mime==='image/webp'){for(let at=12;at+8<=bytes.length;){const n=bytes.readUInt32LE(at+4),end=at+8+n;if(end>bytes.length)throw new Error('WebP元数据长度无效');if(bytes.toString('ascii',at,at+4)==='EXIF')exif(bytes.subarray(at+8,end),'webp');at=end+n%2;}}
    else if(info.mime==='image/png'){for(let at=8;at+12<=bytes.length;){const n=bytes.readUInt32BE(at),end=at+12+n;if(end>bytes.length)throw new Error('PNG元数据长度无效');if(bytes.toString('ascii',at+4,at+8)==='eXIf')exif(bytes.subarray(at+8,at+8+n),'png');at=end;}}
  }catch(error){issue(error instanceof Error?error.message:'图片元数据异常');}
  return{rawWidth:info.width,rawHeight:info.height,width:orientation>=5?info.height:info.width,height:orientation>=5?info.width:info.height,orientation,mime:info.mime,rawExif:{status:issues.length?(fields.some(f=>f.status!=='valid')?'nonstandard':'malformed'):fields.length?'valid':'missing',fields,issues:[...new Set(issues)]},orientationAuthority:'header-only-not-decoded'};
}

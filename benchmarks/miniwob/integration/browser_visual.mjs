// Synthetic-only screenshot capture using the exact current Mecord CDP tab.
// Images are transient, never written to disk or included in JSONL receipts.
import {createHash} from 'node:crypto';
const MAX_SCREENSHOT_BYTES=180_000;
export function allowedSyntheticFrameUrl(url,prefix,authorizedOrigins=[]) {
 if(typeof url!=='string'||typeof prefix!=='string')return false;
 if(url.startsWith(prefix))return true;
 try {
  const parsed=new URL(url);
  return (parsed.protocol==='https:'||parsed.protocol==='http:') &&
   authorizedOrigins.includes(parsed.origin);
 } catch{return false;}
}
export function validateVisualBytes(encoded) {
 if(typeof encoded!=='string'||encoded.length===0||encoded.length>MAX_SCREENSHOT_BYTES*2||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Error('SCREENSHOT_UNAVAILABLE_OR_OVERSIZE');
 const binary=Buffer.from(encoded,'base64');
 if(!binary.length||binary.length>MAX_SCREENSHOT_BYTES||binary[0]!==0xff||
    binary[1]!==0xd8||binary[binary.length-2]!==0xff||
    binary[binary.length-1]!==0xd9)throw Error('SCREENSHOT_JPEG_INVALID');
 return {data:encoded,bytes:binary.length,digest:createHash('sha256').update(binary).digest('hex')};
}
export async function captureSyntheticView(CdpConnection,target,prefix) {
 if(!target||!allowedSyntheticFrameUrl(target.url,prefix)||
    typeof target.id!=='string'||!target.webSocketDebuggerUrl)
  throw Error('SCREENSHOT_TARGET_UNAUTHORIZED');
 const session=new CdpConnection(target.id,target.webSocketDebuggerUrl);
 try {
  const identity=await session.send('Runtime.evaluate',{expression:'location.href',returnByValue:true},5000);
  const observed=identity?.result?.result?.value;
  if(typeof observed!=='string'||!allowedSyntheticFrameUrl(observed,prefix))
   throw Error('SCREENSHOT_NAVIGATION_OUTSIDE_FIXTURE');
  const output=await session.send('Page.captureScreenshot',{
   format:'jpeg',quality:40,fromSurface:true,captureBeyondViewport:false},8000);
  const view=validateVisualBytes(output?.data);
  const after=await session.send('Runtime.evaluate',{expression:'location.href',returnByValue:true},5000);
  if(after?.result?.result?.value!==observed)throw Error('SCREENSHOT_NAVIGATION_CHANGED');
  return view;
 } finally {session.close();}
}

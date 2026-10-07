import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

type DocFormat='pdf'|'docx'|'xlsx'|'pptx'|'csv'|'json'|'png'|'jpeg'|'webp';
const MAX_FILE_BYTES=32*1024*1024;
const MAX_EXTRACT_BYTES=4*1024*1024;
const MAX_ARCHIVE_ENTRIES=2048;
const MAX_ARCHIVE_UNCOMPRESSED=64*1024*1024;
const SCORE:CapabilityScore={reliability:.96,latency:.88,determinism:.98,security:.98,reversibility:1,informationQuality:.9,interactionCost:.02};

export class DocumentDataProvider implements CapabilityProvider{
  readonly name='document-data';
  #scope:PathScope;
  #observationHook?: (filePath:string,phase:'opened'|'before-verify')=>Promise<void>|void;
  constructor(input:{allowedRoots:string[];observationHook?:(filePath:string,phase:'opened'|'before-verify')=>Promise<void>|void}){
    this.#scope=new PathScope(input.allowedRoots);
    this.#observationHook=input.observationHook;
  }
  supports(action:ActionRequest):boolean{
    return ['document.inspect','document.extract','document.render','structured.inspect','structured.extract','structured.render'].includes(action.capability);
  }
  advertises(action:ActionRequest):boolean{return this.supports(action);}
  score():CapabilityScore{return SCORE;}
  async execute(action:ActionRequest):Promise<ActionResult>{
    const started=performance.now();
    if(!this.supports(action)) throw new OperatorError('DOCUMENT_CAPABILITY_UNSUPPORTED','Document/data provider does not support this capability.');
    const requested=String(action.input.path??'');
    if(!requested) throw new OperatorError('DOCUMENT_INPUT_INVALID','Document/data action requires input.path.');
    return await this.#scope.withExisting(requested,async resolved=>{
      const bytes=await readStableBoundedDocument(resolved,this.#observationHook);
      const format=detectFormat(resolved,bytes);
      const structured=action.capability.startsWith('structured.');
      if(structured&&!['csv','json'].includes(format))throw new OperatorError('STRUCTURED_FORMAT_UNSUPPORTED','Structured capabilities currently accept CSV or JSON.');
      if(!structured&&['csv','json'].includes(format)&&action.capability.startsWith('document.')) {
        // Document routes also accept structured formats for transport-neutral clients.
      }
      const base={path:resolved,format,mimeType:mime(format),size:bytes.byteLength,sha256:sha(bytes)};
      let output:Record<string,unknown>;
      if(action.capability.endsWith('.inspect')){
        output={...base,metadata:inspectMetadata(format,bytes)};
      }else{
        const extracted=extract(format,bytes);
        if(action.capability.endsWith('.extract')) output={...base,...extracted};
        else output={...base,...render(format,bytes,extracted)};
      }
      return {
        ok:true,
        capability:action.capability,
        provider:this.name,
        output,
        evidence:[evidence('document_read','pass','Document/data operation completed from a stable read-only source.',{format,sha256:base.sha256})],
        durationMs:Math.round(performance.now()-started)
      };
    });
  }
}

async function readStableBoundedDocument(
  filePath:string,
  hook?:(filePath:string,phase:'opened'|'before-verify')=>Promise<void>|void
):Promise<Buffer>{
  const handle=await fs.open(filePath,'r');
  try{
    const before=await handle.stat({bigint:true});
    if(!before.isFile())throw new OperatorError('DOCUMENT_NOT_FILE','Requested document path is not a regular file.');
    if(before.size>BigInt(MAX_FILE_BYTES))throw new OperatorError('DOCUMENT_TOO_LARGE',`Document exceeds ${MAX_FILE_BYTES} bytes.`);
    const size=Number(before.size);
    if(!Number.isSafeInteger(size)||size<0)throw new OperatorError('DOCUMENT_TOO_LARGE','Document size exceeds the safe numeric range.');
    await hook?.(filePath,'opened');
    const bytes=Buffer.alloc(size);
    let offset=0;
    while(offset<size){
      const {bytesRead}=await handle.read(bytes,offset,size-offset,offset);
      if(bytesRead===0)break;
      offset+=bytesRead;
    }
    await hook?.(filePath,'before-verify');
    const [after,pathState]=await Promise.all([handle.stat({bigint:true}),fs.stat(filePath,{bigint:true})]);
    const stableHandle=['dev','ino','size','mtimeNs','ctimeNs','birthtimeNs'].every(
      key=>before[key as keyof typeof before]===after[key as keyof typeof after]
    );
    const samePath=process.platform==='win32'
      ? before.ino===pathState.ino&&before.birthtimeNs===pathState.birthtimeNs
      : before.dev===pathState.dev&&before.ino===pathState.ino;
    if(offset!==size||!stableHandle||!samePath){
      throw new OperatorError('DOCUMENT_SOURCE_CHANGED','Document identity or bytes changed during bounded observation; retry from a fresh source.',{
        retryable:true,
        details:{sideEffectState:'none',executionPhase:'pre_dispatch',completeRead:offset===size,stableHandle,samePath}
      });
    }
    return bytes;
  }finally{
    await handle.close();
  }
}

function detectFormat(file:string,b:Buffer):DocFormat{
  const ext=path.extname(file).toLowerCase();
  if(b.subarray(0,5).toString('ascii')==='%PDF-')return'pdf';
  if(b.length>=8&&b.readUInt32BE(0)===0x89504e47)return'png';
  if(b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return'jpeg';
  if(b.length>=12&&b.subarray(0,4).toString('ascii')==='RIFF'&&b.subarray(8,12).toString('ascii')==='WEBP')return'webp';
  if(['.docx','.xlsx','.pptx'].includes(ext)&&b.subarray(0,2).toString('ascii')==='PK')return ext.slice(1) as DocFormat;
  if(ext==='.csv')return'csv';
  if(ext==='.json')return'json';
  throw new OperatorError('DOCUMENT_FORMAT_UNSUPPORTED','Supported formats: PDF, DOCX, XLSX, PPTX, CSV, JSON, PNG, JPEG, WEBP.');
}
function mime(f:DocFormat):string{return({
 pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 csv:'text/csv',json:'application/json',png:'image/png',jpeg:'image/jpeg',webp:'image/webp'
} as const)[f];}
function sha(b:Buffer):string{return crypto.createHash('sha256').update(b).digest('hex');}

function inspectMetadata(f:DocFormat,b:Buffer):Record<string,unknown>{
  if(f==='png'&&b.length>=24)return{width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
  if(f==='jpeg')return jpegSize(b);
  if(f==='webp')return webpSize(b);
  if(f==='pdf'){
    const text=b.toString('latin1');
    const pages=(text.match(/\/Type\s*\/Page\b/g)||[]).length;
    return{pages,version:text.slice(5,8)};
  }
  if(f==='docx'||f==='xlsx'||f==='pptx'){
    const entries=zipEntries(b);
    return{archiveEntries:entries.length,containedFiles:entries.map(e=>e.name).slice(0,200)};
  }
  if(f==='csv'){
    const text=utf8(b);const lines=text.split(/\r?\n/);
    return{rows:lines.filter(Boolean).length,columns:parseCsvLine(lines[0]??'').length};
  }
  const parsed=safeJson(b);return{topLevel:Array.isArray(parsed)?'array':typeof parsed,items:Array.isArray(parsed)?parsed.length:undefined,keys:isObject(parsed)?Object.keys(parsed).slice(0,200):undefined};
}

function extract(f:DocFormat,b:Buffer):Record<string,unknown>{
  if(f==='csv'){
    const text=boundedText(utf8(b));const rows=text.split(/\r?\n/).filter(Boolean).slice(0,10000).map(parseCsvLine);
    return{text,rows};
  }
  if(f==='json'){
    const value=safeJson(b);return{text:boundedText(JSON.stringify(value,null,2)),value};
  }
  if(f==='pdf')return{text:extractPdfText(b)};
  if(f==='docx'){
    const xml=zipRead(b,'word/document.xml');return{text:xmlText(xml.toString('utf8'),['w:p','w:br','w:tab'])};
  }
  if(f==='pptx'){
    const entries=zipEntries(b).filter(e=>/^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a,b)=>natural(a.name,b.name));
    const slides=entries.slice(0,500).map((e,i)=>({slide:i+1,text:xmlText(zipReadEntry(b,e).toString('utf8'),['a:p','a:br'])}));
    return{text:boundedText(slides.map(s=>`Slide ${s.slide}\n${s.text}`).join('\n\n')),slides};
  }
  if(f==='xlsx'){
    const shared=zipTryRead(b,'xl/sharedStrings.xml');
    const strings=shared?xmlValues(shared.toString('utf8'),'t'):[];
    const sheets=zipEntries(b).filter(e=>/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a,b)=>natural(a.name,b.name)).slice(0,100);
    const rows=sheets.map((entry,index)=>({sheet:index+1,rows:sheetRows(zipReadEntry(b,entry).toString('utf8'),strings)}));
    return{text:boundedText(rows.map(s=>`Sheet ${s.sheet}\n`+s.rows.map(r=>r.join('\t')).join('\n')).join('\n\n')),sheets:rows};
  }
  if(['png','jpeg','webp'].includes(f))return{metadata:inspectMetadata(f,b),sha256:sha(b)};
  throw new OperatorError('DOCUMENT_FORMAT_UNSUPPORTED','Extraction format is unsupported.');
}

function render(f:DocFormat,b:Buffer,extracted:Record<string,unknown>):Record<string,unknown>{
  if(['png','jpeg','webp'].includes(f)){
    if(b.byteLength>2*1024*1024)return{render:{kind:'image-reference',mimeType:mime(f),sha256:sha(b),metadata:inspectMetadata(f,b)}};
    return{render:{kind:'data-url',mimeType:mime(f),dataUrl:`data:${mime(f)};base64,${b.toString('base64')}`,metadata:inspectMetadata(f,b)}};
  }
  const text=typeof extracted.text==='string'?extracted.text:JSON.stringify(extracted,null,2);
  const html='<!doctype html><meta charset="utf-8"><title>Document preview</title><pre>'+escapeHtml(text.slice(0,MAX_EXTRACT_BYTES))+'</pre>';
  return{render:{kind:'html',mimeType:'text/html',html,sourceSha256:sha(b),originalPreserved:true}};
}

function extractPdfText(b:Buffer):string{
  const s=b.toString('latin1');
  const out:string[]=[];
  const re=/\((?:\\.|[^\\)]){1,4096}\)\s*Tj|\[(.{1,16384}?)\]\s*TJ/gs;
  for(const m of s.matchAll(re)){
    const chunk=m[0];for(const sm of chunk.matchAll(/\((?:\\.|[^\\)])*\)/g))out.push(pdfUnescape(sm[0].slice(1,-1)));
    if(out.join(' ').length>MAX_EXTRACT_BYTES)break;
  }
  return boundedText(out.join(' ').replace(/\s+/g,' ').trim());
}
function pdfUnescape(s:string):string{return s.replace(/\\([nrtbf()\\])/g,(_,c)=>({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f','(':'(',')':')','\\':'\\'} as any)[c]??c).replace(/\\([0-7]{1,3})/g,(_,o)=>String.fromCharCode(parseInt(o,8)));}

type ZipEntry={name:string;compression:number;compressedSize:number;uncompressedSize:number;localOffset:number};
function zipEntries(b:Buffer):ZipEntry[]{
  const min=Math.max(0,b.length-65557);let eocd=-1;
  for(let i=b.length-22;i>=min;i--){if(b.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
  if(eocd<0)throw new OperatorError('DOCUMENT_ARCHIVE_INVALID','ZIP end-of-central-directory not found.');
  const count=b.readUInt16LE(eocd+10),cdOffset=b.readUInt32LE(eocd+16);
  if(count>MAX_ARCHIVE_ENTRIES)throw new OperatorError('DOCUMENT_ARCHIVE_TOO_LARGE','Archive contains too many entries.');
  const out:ZipEntry[]=[];let p=cdOffset,total=0;
  for(let i=0;i<count;i++){
    if(p+46>b.length||b.readUInt32LE(p)!==0x02014b50)throw new OperatorError('DOCUMENT_ARCHIVE_INVALID','ZIP central directory is invalid.');
    const compression=b.readUInt16LE(p+10),compressedSize=b.readUInt32LE(p+20),uncompressedSize=b.readUInt32LE(p+24);
    const nameLen=b.readUInt16LE(p+28),extraLen=b.readUInt16LE(p+30),commentLen=b.readUInt16LE(p+32),localOffset=b.readUInt32LE(p+42);
    const name=b.subarray(p+46,p+46+nameLen).toString('utf8');
    if(!name||name.includes('..')||name.startsWith('/')||name.includes('\\'))throw new OperatorError('DOCUMENT_ARCHIVE_INVALID','Archive entry path is unsafe.');
    total+=uncompressedSize;if(total>MAX_ARCHIVE_UNCOMPRESSED)throw new OperatorError('DOCUMENT_ARCHIVE_TOO_LARGE','Archive expands beyond the bounded limit.');
    out.push({name,compression,compressedSize,uncompressedSize,localOffset});p+=46+nameLen+extraLen+commentLen;
  }
  return out;
}
function zipRead(b:Buffer,name:string):Buffer{const e=zipEntries(b).find(x=>x.name===name);if(!e)throw new OperatorError('DOCUMENT_PART_MISSING',`Required archive part ${name} is missing.`);return zipReadEntry(b,e);}
function zipTryRead(b:Buffer,name:string):Buffer|undefined{const e=zipEntries(b).find(x=>x.name===name);return e?zipReadEntry(b,e):undefined;}
function zipReadEntry(b:Buffer,e:ZipEntry):Buffer{
  const p=e.localOffset;if(p+30>b.length||b.readUInt32LE(p)!==0x04034b50)throw new OperatorError('DOCUMENT_ARCHIVE_INVALID','ZIP local header is invalid.');
  const nameLen=b.readUInt16LE(p+26),extraLen=b.readUInt16LE(p+28),start=p+30+nameLen+extraLen,end=start+e.compressedSize;
  if(end>b.length)throw new OperatorError('DOCUMENT_ARCHIVE_INVALID','ZIP entry is truncated.');
  const src=b.subarray(start,end);let out:Buffer;
  if(e.compression===0)out=Buffer.from(src);else if(e.compression===8)out=zlib.inflateRawSync(src,{maxOutputLength:Math.min(MAX_ARCHIVE_UNCOMPRESSED,e.uncompressedSize+1024)});else throw new OperatorError('DOCUMENT_ARCHIVE_COMPRESSION_UNSUPPORTED','ZIP entry compression method is unsupported.');
  if(out.byteLength!==e.uncompressedSize)throw new OperatorError('DOCUMENT_ARCHIVE_INVALID','ZIP entry size does not match central directory.');
  return out;
}
function xmlText(xml:string,breakTags:string[]):string{
  let s=xml;for(const tag of breakTags){s=s.replace(new RegExp('<\\/?'+tag+'(?:\\s[^>]*)?>','g'),'\n');}
  s=s.replace(/<[^>]+>/g,' ');return boundedText(decodeXml(s).replace(/[ \t]+/g,' ').replace(/\n\s*/g,'\n').trim());
}
function xmlValues(xml:string,localName:string):string[]{const out:string[]=[];const re=new RegExp('<(?:\\w+:)?'+localName+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?'+localName+'>','g');for(const m of xml.matchAll(re)){out.push(decodeXml(m[1]!.replace(/<[^>]+>/g,'')));if(out.length>100000)break;}return out;}
function sheetRows(xml:string,shared:string[]):string[][]{
  const rows:string[][]=[];for(const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){
    const row:string[]=[];for(const cm of rm[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){
      const attrs=cm[1]!,body=cm[2]!;const v=(body.match(/<v>([\s\S]*?)<\/v>/)?.[1]??body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1]??'');
      row.push(attrs.includes('t="s"')?shared[Number(v)]??'':decodeXml(v));
    }rows.push(row);if(rows.length>=10000)break;
  }return rows;
}
function parseCsvLine(line:string):string[]{const out:string[]=[];let cur='',q=false;for(let i=0;i<line.length;i++){const ch=line[i]!;if(q){if(ch==='"'&&line[i+1]==='"'){cur+='"';i++;}else if(ch==='"')q=false;else cur+=ch;}else if(ch==='"')q=true;else if(ch===','){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out;}
function utf8(b:Buffer):string{const s=new TextDecoder('utf-8',{fatal:true}).decode(b);return s;}
function safeJson(b:Buffer):unknown{let v:unknown;try{v=JSON.parse(utf8(b));}catch{throw new OperatorError('STRUCTURED_JSON_INVALID','JSON file is invalid UTF-8 JSON.');}return v;}
function isObject(v:unknown):v is Record<string,unknown>{return Boolean(v&&typeof v==='object'&&!Array.isArray(v));}
function decodeXml(s:string):string{return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));}
function boundedText(s:string):string{const b=Buffer.from(s,'utf8');return b.byteLength<=MAX_EXTRACT_BYTES?s:b.subarray(0,MAX_EXTRACT_BYTES).toString('utf8');}
function escapeHtml(s:string):string{return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as any)[c]);}
function natural(a:string,b:string):number{return a.localeCompare(b,undefined,{numeric:true});}
function jpegSize(b:Buffer):Record<string,unknown>{let p=2;while(p+9<b.length){if(b[p]!==0xff){p++;continue;}const marker=b[p+1]!;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){return{height:b.readUInt16BE(p+5),width:b.readUInt16BE(p+7)};}const len=b.readUInt16BE(p+2);if(len<2)break;p+=2+len;}return{};}
function webpSize(b:Buffer):Record<string,unknown>{const kind=b.subarray(12,16).toString('ascii');if(kind==='VP8X'&&b.length>=30){const w=1+b.readUIntLE(24,3),h=1+b.readUIntLE(27,3);return{width:w,height:h};}return{};}

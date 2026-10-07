import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DocumentDataProvider } from '../src/capabilities/document-data.ts';

function action(capability:string,file:string){return{id:'doc-'+capability,capability,risk:'read' as const,input:{path:file},provenance:{kind:'runtime' as const}};}

function storedZip(entries:Record<string,string>):Buffer{
  const locals:Buffer[]=[];const centrals:Buffer[]=[];let offset=0;
  for(const [name,text] of Object.entries(entries)){
    const nameBytes=Buffer.from(name),data=Buffer.from(text);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);local.writeUInt16LE(0,8);local.writeUInt32LE(0,10);local.writeUInt32LE(0,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);local.writeUInt16LE(0,28);
    locals.push(local,nameBytes,data);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0,8);central.writeUInt16LE(0,10);central.writeUInt32LE(0,12);central.writeUInt32LE(0,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);central.writeUInt32LE(0,38);central.writeUInt32LE(offset,42);
    centrals.push(central,nameBytes);offset+=local.length+nameBytes.length+data.length;
  }
  const cd=Buffer.concat(centrals);const eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(0,4);eocd.writeUInt16LE(0,6);eocd.writeUInt16LE(Object.keys(entries).length,8);eocd.writeUInt16LE(Object.keys(entries).length,10);eocd.writeUInt32LE(cd.length,12);eocd.writeUInt32LE(offset,16);eocd.writeUInt16LE(0,20);
  return Buffer.concat([...locals,cd,eocd]);
}

test('document/data provider inspects extracts and renders CSV JSON PDF and images',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r6-docs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'data.csv'),'name,value\nalpha,1\nbeta,2\n');
  await fs.writeFile(path.join(root,'data.json'),JSON.stringify({alpha:1,beta:[2,3]}));
  await fs.writeFile(path.join(root,'sample.pdf'),'%PDF-1.7\n1 0 obj << /Type /Page >> endobj\nBT (Hello PDF) Tj ET\n%%EOF','latin1');
  const png=Buffer.alloc(24);png.writeUInt32BE(0x89504e47,0);png.writeUInt32BE(640,16);png.writeUInt32BE(480,20);await fs.writeFile(path.join(root,'image.png'),png);
  const provider=new DocumentDataProvider({allowedRoots:[root]});
  const csv=await provider.execute(action('structured.extract',path.join(root,'data.csv')));assert.equal(csv.ok,true);assert.equal((csv.output as any).rows[1][0],'alpha');
  const json=await provider.execute(action('structured.render',path.join(root,'data.json')));assert.match((json.output as any).render.html,/alpha/);
  const pdf=await provider.execute(action('document.extract',path.join(root,'sample.pdf')));assert.match((pdf.output as any).text,/Hello PDF/);
  const image=await provider.execute(action('document.inspect',path.join(root,'image.png')));assert.deepEqual((image.output as any).metadata,{width:640,height:480});
});

test('document/data provider extracts DOCX XLSX and PPTX OOXML parts',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r6-ooxml-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'sample.docx'),storedZip({'word/document.xml':'<w:document><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>'}));
  await fs.writeFile(path.join(root,'sample.xlsx'),storedZip({
    'xl/sharedStrings.xml':'<sst><si><t>Hello XLSX</t></si></sst>',
    'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row></sheetData></worksheet>'
  }));
  await fs.writeFile(path.join(root,'sample.pptx'),storedZip({'ppt/slides/slide1.xml':'<p:sld><p:cSld><a:p><a:r><a:t>Hello PPTX</a:t></a:r></a:p></p:cSld></p:sld>'}));
  const provider=new DocumentDataProvider({allowedRoots:[root]});
  for(const [file,needle] of [['sample.docx','Hello DOCX'],['sample.xlsx','Hello XLSX'],['sample.pptx','Hello PPTX']] as const){
    const result=await provider.execute(action('document.extract',path.join(root,file)));assert.equal(result.ok,true);assert.match(String((result.output as any).text),new RegExp(needle));
    const rendered=await provider.execute(action('document.render',path.join(root,file)));assert.match(String((rendered.output as any).render.html),new RegExp(needle));
  }
});

test('document provider fails closed on out-of-scope and unsupported formats',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r6-scope-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'r6-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'bad.bin'),'nope');await fs.writeFile(path.join(outside,'data.csv'),'a,b\n1,2\n');
  const provider=new DocumentDataProvider({allowedRoots:[root]});
  await assert.rejects(()=>provider.execute(action('document.inspect',path.join(root,'bad.bin'))),(e:any)=>e?.code==='DOCUMENT_FORMAT_UNSUPPORTED');
  await assert.rejects(()=>provider.execute(action('structured.extract',path.join(outside,'data.csv'))),(e:any)=>e?.code==='PATH_OUTSIDE_SCOPE');
});

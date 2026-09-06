const {spawn}=require('child_process');
const fs=require('fs/promises');
const fssync=require('fs');
const os=require('os');
const path=require('path');
const zlib=require('zlib');
const {pipeline}=require('stream/promises');
const {Readable}=require('stream');

const MAX_CHUNK=120; // 2 min, friendlier to Gemini Free Tier rate limits
const FFMPEG_URL='https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz';
const FFMPEG_PATH=path.join(os.tmpdir(),'ffmpeg-6.1.1-linux-x64');
let ffmpegReadyPromise=null;

function safeHttps(u){
  try{
    const x=new URL(u);
    return x.protocol==='https:' && !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(x.hostname);
  }catch{return false}
}

async function ensureFfmpeg(){
  try{await fs.access(FFMPEG_PATH, fssync.constants.X_OK);return FFMPEG_PATH}catch{}
  if(ffmpegReadyPromise)return ffmpegReadyPromise;
  ffmpegReadyPromise=(async()=>{
    const tmp=FFMPEG_PATH+'.download';
    const r=await fetch(FFMPEG_URL,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0'}});
    if(!r.ok||!r.body)throw new Error(`下载 ffmpeg 失败 HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body),zlib.createGunzip(),fssync.createWriteStream(tmp,{mode:0o755}));
    await fs.chmod(tmp,0o755);
    await fs.rename(tmp,FFMPEG_PATH).catch(async()=>{
      try{await fs.access(FFMPEG_PATH)}catch{throw new Error('ffmpeg 写入 /tmp 失败')}
      await fs.rm(tmp,{force:true}).catch(()=>{});
    });
    return FFMPEG_PATH;
  })().catch(e=>{ffmpegReadyPromise=null;throw e});
  return ffmpegReadyPromise;
}

function run(bin,args){
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,args,{stdio:['ignore','ignore','pipe']});
    let err='';
    p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000)});
    p.on('error',reject);
    p.on('close',c=>c===0?resolve():reject(new Error('ffmpeg failed: '+err.slice(-1800))));
  });
}
function sec(v){if(v==null)return 0;const m=String(v).match(/([0-9.]+)s/);return m?Number(m[1]):Number(v)||0}
function extractWords(j){const out=[];for(const step of j.steps||[])for(const content of step.content||[])for(const a of content.annotations||[])if(a.type==='word_info')out.push(a);return out}
function joinWords(words,offset){const segs=[];for(const w of words){const sp=w.speaker||'spk_unknown',start=sec(w.start_offset)+offset,end=sec(w.end_offset)+offset,t=String(w.text||'').trim();if(!t)continue;const last=segs.at(-1);if(last&&last.rawSpeaker===sp&&(start-last.end)<2.2){const cjk=/[\u3400-\u9fff\uf900-\ufaff]/;last.text+=(!cjk.test(last.text.slice(-1))&&!cjk.test(t[0])&&!/^[,.;:!?，。！？；：、]/.test(t)?' ':'')+t;last.end=Math.max(last.end,end)}else segs.push({rawSpeaker:sp,start,end,text:t})}return segs}
async function upload(file,apiKey){const st=await fs.stat(file);const start=await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`,{method:'POST',headers:{'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(st.size),'X-Goog-Upload-Header-Content-Type':'audio/mpeg','Content-Type':'application/json'},body:JSON.stringify({file:{display_name:path.basename(file)}})});if(!start.ok)throw new Error(`Gemini 上传初始化 HTTP ${start.status}: ${(await start.text()).slice(0,300)}`);const up=start.headers.get('x-goog-upload-url');if(!up)throw new Error('Gemini 没有返回 upload URL');const buf=await fs.readFile(file);const done=await fetch(up,{method:'POST',headers:{'Content-Length':String(buf.length),'X-Goog-Upload-Offset':'0','X-Goog-Upload-Command':'upload, finalize'},body:buf});const tx=await done.text();let j;try{j=JSON.parse(tx)}catch{j={}}if(!done.ok)throw new Error(`Gemini 文件上传 HTTP ${done.status}: ${tx.slice(0,300)}`);if(!j.file?.uri)throw new Error('Gemini 上传成功但没有 file URI');return j.file}
async function del(name,key){if(name)await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(key)}`,{method:'DELETE'}).catch(()=>{})}
async function transcribe(file,key){const f=await upload(file,key);try{const r=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify({model:'gemini-3.5-transcribe',input:[{type:'audio',uri:f.uri,mime_type:f.mimeType||f.mime_type||'audio/mpeg'}],generation_config:{transcription_config:{language_codes:[],mode:{type:'verbatim',diarization_mode:'speaker',timestamp_granularities:['word']}}}})});const tx=await r.text();let j;try{j=JSON.parse(tx)}catch{throw new Error(`Gemini 返回非 JSON：${tx.slice(0,300)}`)}if(!r.ok)throw new Error(j?.error?.message||`Gemini HTTP ${r.status}`);return j}finally{await del(f.name,key)}}

module.exports=async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const {mediaUrl,referer,apiKey,startSeconds=0,durationSeconds=120,chunkIndex=0}=req.body||{};
  if(!safeHttps(mediaUrl)||!safeHttps(referer))return res.status(400).json({error:'媒体地址无效'});
  if(!apiKey)return res.status(400).json({error:'缺少 Gemini API Key'});
  const dur=Math.min(MAX_CHUNK,Math.max(60,Number(durationSeconds)||120)),start=Math.max(0,Number(startSeconds)||0);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eeo-chunk-'));
  const out=path.join(dir,'audio.mp3');
  try{
    const ffmpegPath=await ensureFfmpeg();
    await run(ffmpegPath,['-hide_banner','-loglevel','warning','-headers',`Referer: ${referer}\r\nUser-Agent: Mozilla/5.0\r\n`,'-ss',String(start),'-i',mediaUrl,'-t',String(dur),'-vn','-ac','1','-ar','16000','-b:a','24k','-y',out]);
    const st=await fs.stat(out).catch(()=>null);
    if(!st||st.size<2500)return res.status(200).json({ok:true,done:true,chunkIndex,startSeconds:start});
    const j=await transcribe(out,apiKey);
    const text=j.output_text||j.outputText||'';
    let segs=joinWords(extractWords(j),start);
    if(!segs.length&&text)segs=[{rawSpeaker:'spk_unknown',start,end:start+dur,text}];
    const totals={};for(const s of segs)totals[s.rawSpeaker]=(totals[s.rawSpeaker]||0)+Math.max(0,s.end-s.start);
    const dominant=Object.entries(totals).sort((a,b)=>b[1]-a[1])[0]?.[0];
    segs=segs.map(s=>({speaker:s.rawSpeaker===dominant?'TEACHER_CANDIDATE':`C${Number(chunkIndex)+1}_${s.rawSpeaker}`,start:s.start,end:s.end,text:s.text}));
    return res.status(200).json({ok:true,done:false,chunkIndex,startSeconds:start,durationSeconds:dur,text,segments:segs,dominantSpeaker:dominant});
  }catch(e){
    console.error('CHUNK_FAILED',e);
    const message=e?.message||String(e);
    const retry=message.match(/retry in\s+([0-9.]+)s/i);
    if(retry||/quota exceeded|rate limit|resource_exhausted/i.test(message)){
      const retryAfterSeconds=retry?Math.max(5,Math.ceil(Number(retry[1]))):40;
      return res.status(429).json({
        error:'Gemini Free Tier 暂时达到速度上限，系统会自动等待后继续。',
        code:'GEMINI_FREE_RATE_LIMIT',
        retryAfterSeconds,
        chunkIndex,
        startSeconds:start
      });
    }
    return res.status(500).json({error:message,code:'CHUNK_FAILED',chunkIndex,startSeconds:start});
  }finally{
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
};
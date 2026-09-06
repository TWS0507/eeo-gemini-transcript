const allowed = new Set(['live.eeo.cn','www.eeo.cn','eeo.cn','api.eeo.cn']);
function validReplayUrl(input){
  try { const u=new URL(input); return u.protocol==='https:' && allowed.has(u.hostname.toLowerCase()) && !!u.searchParams.get('lessonKey'); }
  catch { return false; }
}
function score(u){ const s=u.toLowerCase(); if(s.includes('.m3u8')) return 100; if(/\.(mp4|m4a|mp3|webm)(\?|$)/.test(s)) return 80; if(/play|record|replay/.test(s)) return 20; return 1; }
async function fetchText(url,referer){
  const r=await fetch(url,{headers:{referer,'user-agent':'Mozilla/5.0'}});
  if(!r.ok) throw new Error(`媒体清单 HTTP ${r.status}`);
  return r.text();
}
async function resolveHls(url,referer){
  let txt=await fetchText(url,referer);
  let finalUrl=url;
  if(txt.includes('#EXT-X-STREAM-INF')){
    const lines=txt.split(/\r?\n/); const candidates=[];
    for(let i=0;i<lines.length;i++) if(lines[i].startsWith('#EXT-X-STREAM-INF')){
      const m=lines[i].match(/BANDWIDTH=(\d+)/); let j=i+1; while(j<lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if(j<lines.length) candidates.push({bw:Number(m?.[1]||0),url:new URL(lines[j],url).href});
    }
    candidates.sort((a,b)=>b.bw-a.bw); if(candidates[0]){ finalUrl=candidates[0].url; txt=await fetchText(finalUrl,referer); }
  }
  let duration=0; for(const m of txt.matchAll(/#EXTINF:([0-9.]+)/g)) duration+=Number(m[1]);
  return {playlistUrl:finalUrl,durationSeconds:duration||null};
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const {url}=req.body||{}; if(!validReplayUrl(url)) return res.status(400).json({error:'请输入带 lessonKey 的 EEO / ClassIn 回放链接'});
  let browser;
  try{
    let chromium, puppeteer;
    try {
      const cm = await import('@sparticuz/chromium-min');
      chromium = cm.default || cm;
      const pm = await import('puppeteer-core');
      puppeteer = pm.default || pm;
    } catch (e) {
      console.error('BROWSER_MODULE_LOAD_FAILED', e);
      return res.status(500).json({error:'浏览器组件载入失败：'+e.message,code:'BROWSER_MODULE_LOAD_FAILED'});
    }
    browser=await puppeteer.launch({args:[...chromium.args,'--autoplay-policy=no-user-gesture-required'],defaultViewport:{width:1365,height:768},executablePath:await chromium.executablePath('https://github.com/Sparticuz/chromium/releases/download/v138.0.2/chromium-v138.0.2-pack.x64.tar'),headless:'shell'});
    const page=await browser.newPage(); page.setDefaultTimeout(12000); const media=new Map();
    const add=(u,ct='')=>{ if(!u||!/^https?:\/\//i.test(u)) return; if(/m3u8|mp4|m4a|mp3|webm|mpegurl|audio|video/i.test(u+' '+ct)) media.set(u,{url:u,contentType:ct,score:score(u)}); };
    page.on('response',r=>{try{add(r.url(),r.headers()['content-type']||'')}catch{}});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
    await new Promise(r=>setTimeout(r,1800));
    await page.evaluate(()=>{try{document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.play?.().catch(()=>{})})}catch{}; const words=['播放','开始播放','Play','观看','回放']; [...document.querySelectorAll('button,[role=button],a')].forEach(el=>{if(words.some(w=>(el.innerText||'').includes(w)))try{el.click()}catch{}})}).catch(()=>{});
    await new Promise(r=>setTimeout(r,6500));
    const entries=await page.evaluate(()=>{const out=[]; performance.getEntriesByType('resource').forEach(x=>out.push(x.name)); document.querySelectorAll('video,audio,source').forEach(x=>{if(x.src)out.push(x.src)}); return out}).catch(()=>[]);
    entries.forEach(u=>add(u)); const arr=[...media.values()].sort((a,b)=>b.score-a.score);
    if(!arr.length) return res.status(422).json({error:'没有侦测到可直接下载的回放媒体。可能需要登录，或媒体地址由受保护接口生成。'});
    const picked=arr.find(x=>/\.m3u8(\?|$)/i.test(x.url))||arr.find(x=>/\.(mp4|m4a|mp3|webm)(\?|$)/i.test(x.url))||arr[0];
    let hls=null; if(/\.m3u8(\?|$)/i.test(picked.url)) hls=await resolveHls(picked.url,url).catch(()=>null);
    return res.status(200).json({ok:true,title:await page.title().catch(()=>''),kind:hls?'hls':'direct',mediaUrl:hls?.playlistUrl||picked.url,durationSeconds:hls?.durationSeconds||null,referer:url});
  }catch(e){ console.error('DISCOVER_FAILED', e); return res.status(500).json({error:'找回放媒体失败：'+e.message,code:'DISCOVER_FAILED'}); }
  finally{ if(browser) await browser.close().catch(()=>{}); }
};
module.exports=async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const {apiKey,transcript}=req.body||{};
  if(!apiKey||typeof apiKey!=='string')return res.status(400).json({error:'缺少 Gemini API Key'});
  if(!transcript||typeof transcript!=='string'||!transcript.trim())return res.status(400).json({error:'没有可总结的逐字稿'});
  // 课堂逐字稿通常远低于此限制；避免异常巨型请求拖垮函数。
  const text=transcript.slice(0,600000);
  const prompt=`你是一位优秀的教学主任，正在整理一堂补习课堂的老师逐字稿。请只根据逐字稿内容总结，不要捏造没有出现的知识点。输出使用简体中文，保留必要的英文/BM术语。\n\n请严格按照以下结构输出，内容要具体、可直接复制使用：\n\n【1｜本堂课一句话主题】\n用1-2句说明这堂课到底在教什么。\n\n【2｜课堂核心重点】\n提炼5-10个真正重要的教学重点；如果老师有口诀、步骤、公式、Keyword，一定保留原意。\n\n【3｜老师讲解路线】\n按课堂实际顺序总结老师是怎样从例子/问题带到知识点、练习和考试题的。\n\n【4｜可直接复用的老师话术】\n从老师表达方式中整理出8-15句最值得保留、以后上课可以再次使用的话术。允许轻微整理口语，但不要改变意思。\n\n【5｜学生容易卡住 / 常见错误】\n只列逐字稿中可以合理看出的理解难点、误区或老师反复提醒的地方。\n\n【6｜考点 / 答题技巧 / Keyword】\n整理所有和考试、作答步骤、得分点、Keyword有关的内容。如果这堂课没有明确提到，请写“本段逐字稿未明确提到”。\n\n【7｜30秒课后复盘】\n最后用一个短段落总结：学生今天学会了什么、老师下次复习时最应该抓哪几个点。\n\n老师逐字稿如下：\n---\n${text}\n---`;
  try{
    const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',{
      method:'POST',headers:{'x-goog-api-key':apiKey,'content-type':'application/json'},
      body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.2,maxOutputTokens:12000}})
    });
    const raw=await r.text();let j;try{j=JSON.parse(raw)}catch{return res.status(502).json({error:`Gemini 返回非 JSON：${raw.slice(0,300)}`})}
    if(!r.ok)return res.status(r.status).json({error:j?.error?.message||`Gemini HTTP ${r.status}`});
    const summary=(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim();
    if(!summary)return res.status(502).json({error:'Gemini 没有返回总结内容'});
    return res.status(200).json({ok:true,model:'gemini-3.5-flash',summary});
  }catch(e){return res.status(500).json({error:'AI 总结失败：'+e.message})}
};
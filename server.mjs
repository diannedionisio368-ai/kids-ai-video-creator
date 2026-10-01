import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const jobs = new Map();
const publicDir = path.join(__dirname, "public");
const outputDir = path.join(os.tmpdir(), "kids-ai-video-creator");

await fs.mkdir(outputDir, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

function cleanText(x, max=4000) {
  return String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function requireKey() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "your_api_key_here") {
    const e = new Error("OPENAI_API_KEY is missing. Add your API key to the server .env file.");
    e.code = "MISSING_API_KEY";
    throw e;
  }
}

function publicError(err) {
  const msg = err?.message || String(err);
  if (/401|invalid.*api.*key|incorrect api key/i.test(msg)) return "OpenAI API key was rejected. Check the key in .env.";
  if (/429|quota|billing|insufficient/i.test(msg)) return "The OpenAI account reached a usage limit or needs billing/credits.";
  if (/403|permission|access/i.test(msg)) return "This OpenAI project does not have permission to use the requested model.";
  return msg.slice(0, 900);
}

async function openaiFetch(url, options={}) {
  requireKey();
  const r = await fetch(`https://api.openai.com${url}`, {
    ...options,
    headers: { Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, ...(options.headers || {}) }
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw:text}; }
  if (!r.ok) {
    const detail = data?.error?.message || data?.raw || `HTTP ${r.status}`;
    const e = new Error(detail);
    e.status = r.status;
    throw e;
  }
  return data;
}

async function planLesson({prompt, age, style, length}) {
  requireKey();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: process.env.TEXT_MODEL || "gpt-5.6-luna",
    input: `Create a short, safe, educational kids video plan.
Topic: ${cleanText(prompt)}
Age: ${age}
Visual style: ${style}
Requested length: ${length} seconds.

Return ONLY valid JSON with:
{
 "title": string,
 "narration": string,
 "scenes": [
   {"visual_prompt": string, "narration": string, "caption": string}
 ]
}

Rules:
- Make it cheerful and age appropriate.
- Use friendly fictional/cartoon characters or animals.
- No scary, violent, romantic, dangerous, or adult content.
- Keep each scene visually concrete: characters and objects must be visible and moving.
- Make 3 scenes for 30 seconds, 5 scenes for 60 seconds, and 8 scenes for 120 seconds.
- Keep total narration short enough for the requested duration.
- Each visual_prompt should describe a self-contained vertical 9:16 animated scene.
- Avoid asking the video model to render readable text. Captions will be added separately.`
  });
  const raw = response.output_text || "";
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("The story planner returned an invalid response. Try the prompt again.");
    parsed = JSON.parse(m[0]);
  }
  if (!Array.isArray(parsed.scenes) || !parsed.scenes.length) throw new Error("The story planner did not return scenes.");
  return parsed;
}

async function createVideoJob(visualPrompt, seconds) {
  const form = new FormData();
  form.append("model", process.env.VIDEO_MODEL || "sora-2");
  form.append("prompt", visualPrompt);
  form.append("seconds", String(seconds));
  form.append("size", "720x1280");
  return openaiFetch("/v1/videos", { method:"POST", body:form });
}

async function waitForVideo(id, onProgress) {
  for (;;) {
    const v = await openaiFetch(`/v1/videos/${encodeURIComponent(id)}`);
    if (onProgress) onProgress(v.progress || 0, v.status);
    if (v.status === "completed") return v;
    if (v.status === "failed") {
      throw new Error(v.error?.message || "AI video generation failed.");
    }
    await new Promise(r => setTimeout(r, 4000));
  }
}

async function downloadVideo(id, file) {
  requireKey();
  const r = await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content`, {
    headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}` }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Video download failed: ${t.slice(0,400)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(file, buf);
}

async function makeSpeech(text, file) {
  const data = await openaiFetch("/v1/audio/speech", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
      voice:"coral",
      input: text,
      instructions:"Warm, cheerful, friendly educational narrator for children. Speak clearly and naturally. Do not sound scary or overly excited.",
      response_format:"mp3"
    })
  });
  // openaiFetch parses JSON, so speech is handled separately below.
  return data;
}

async function downloadSpeech(text, file) {
  requireKey();
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method:"POST",
    headers:{
      Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:process.env.TTS_MODEL || "gpt-4o-mini-tts",
      voice:"coral",
      input:text.slice(0,4096),
      instructions:"Warm, cheerful, friendly educational narrator for children. Speak clearly, naturally, and at a comfortable teaching pace.",
      response_format:"mp3"
    })
  });
  if (!r.ok) {
    const t = await r.text();
    let msg=t;
    try { msg=JSON.parse(t)?.error?.message || t; } catch {}
    throw new Error(`Narration generation failed: ${msg.slice(0,500)}`);
  }
  await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
}

async function runFfmpeg(args) {
  return await new Promise((resolve,reject)=>{
    const {spawn}=await import("node:child_process");
    const p=spawn(ffmpegPath, args, {stdio:["ignore","ignore","pipe"]});
    let err="";
    p.stderr.on("data",d=>err+=d.toString());
    p.on("error",reject);
    p.on("close",code=>code===0?resolve():reject(new Error("Video finishing failed: "+err.slice(-1200))));
  });
}

async function concatClips(clips, out) {
  const list = path.join(outputDir, `${crypto.randomUUID()}.txt`);
  await fs.writeFile(list, clips.map(x=>`file '${x.replace(/'/g,"'\\''")}'`).join("\n"));
  await runFfmpeg(["-y","-f","concat","-safe","0","-i",list,"-c","copy",out]);
  await fs.rm(list,{force:true});
}

async function muxNarration(video, narration, out) {
  await runFfmpeg(["-y","-i",video,"-i",narration,"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-b:a","128k","-shortest",out]);
}

async function burnCaptions(video, plan, totalSeconds, out) {
  // Captions are generated as an SRT and burned in with ffmpeg.
  const srt = path.join(outputDir, `${crypto.randomUUID()}.srt`);
  const n = plan.scenes.length;
  const each = totalSeconds / n;
  const ts = s => {
    const ms=Math.max(0,Math.round(s*1000));
    const h=Math.floor(ms/3600000); const m=Math.floor((ms%3600000)/60000);
    const sec=Math.floor((ms%60000)/1000); const milli=ms%1000;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")},${String(milli).padStart(3,"0")}`;
  };
  const lines=plan.scenes.map((sc,i)=>`${i+1}\n${ts(i*each)} --> ${ts(Math.min(totalSeconds,(i+1)*each))}\n${String(sc.caption||sc.narration||"").replace(/[\r\n]+/g," ")}\n`).join("\n");
  await fs.writeFile(srt,lines,"utf8");
  const filter=`subtitles='${srt.replace(/\\/g,"/").replace(/:/g,"\\:").replace(/'/g,"'\\\\''")}'`;
  await runFfmpeg(["-y","-i",video,"-vf",filter,"-c:v","libx264","-preset","veryfast","-crf","20","-c:a","aac","-b:a","128k",out]);
  await fs.rm(srt,{force:true});
}

async function generateJob(jobId, input) {
  const job=jobs.get(jobId);
  try {
    job.status="planning"; job.message="Creating the lesson and scene prompts...";
    const plan=await planLesson(input);
    job.plan=plan; job.progress=8;

    const requested=Number(input.length);
    const sceneCount=plan.scenes.length;
    // Use 12-second Sora clips when possible; final duration is controlled by clip count + trim.
    const clipSeconds = requested <= 30 ? 12 : 12;
    const clips=[];
    for (let i=0;i<sceneCount;i++) {
      job.status="video";
      job.message=`Generating AI animation ${i+1} of ${sceneCount}...`;
      const v=await createVideoJob(plan.scenes[i].visual_prompt,clipSeconds);
      const done=await waitForVideo(v.id,(p)=>{ job.progress=Math.min(78,10 + ((i + p/100)/sceneCount)*60); });
      const clip=path.join(outputDir,`${jobId}-${i}.mp4`);
      await downloadVideo(done.id,clip);
      clips.push(clip);
    }
    const raw=path.join(outputDir,`${jobId}-raw.mp4`);
    await concatClips(clips,raw);
    job.progress=80;

    job.status="narration"; job.message="Creating cheerful AI narration...";
    const narrationText=plan.narration || plan.scenes.map(s=>s.narration).join(" ");
    const audio=path.join(outputDir,`${jobId}.mp3`);
    await downloadSpeech(narrationText,audio);

    const voiced=path.join(outputDir,`${jobId}-voiced.mp4`);
    await muxNarration(raw,audio,voiced);
    job.progress=90;

    job.status="captions"; job.message="Adding captions...";
    const final=path.join(outputDir,`${jobId}-final.mp4`);
    await burnCaptions(voiced,plan,Math.min(requested,sceneCount*clipSeconds),final);
    job.progress=100; job.status="completed"; job.message="Your AI kids video is ready!";
    job.file=final;
  } catch (err) {
    console.error(err);
    job.status="failed";
    job.message=publicError(err);
  }
}

app.get("/api/health", async (_req,res)=>{
  const configured=!!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY!=="your_api_key_here";
  res.json({ok:true,configured,node:process.version,ffmpeg:!!ffmpegPath,videoModel:process.env.VIDEO_MODEL||"sora-2",textModel:process.env.TEXT_MODEL||"gpt-5.6-luna"});
});

app.post("/api/generate", async (req,res)=>{
  try {
    const {prompt,age="6-8",length=30,style="cute 2D cartoon"}=req.body||{};
    if (!cleanText(prompt,1200)) return res.status(400).json({error:"Please enter what the video should teach."});
    requireKey();
    const id=crypto.randomUUID();
    jobs.set(id,{id,status:"queued",progress:0,message:"Starting...",createdAt:Date.now()});
    generateJob(id,{prompt:cleanText(prompt,1200),age,length:Number(length),style:cleanText(style,100)}).catch(()=>{});
    res.json({jobId:id});
  } catch(err) {
    res.status(400).json({error:publicError(err)});
  }
});

app.get("/api/jobs/:id",(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({error:"Job not found."});
  const data={...job};
  delete data.file;
  if(job.status==="completed") data.videoUrl=`/api/jobs/${job.id}/video`;
  res.json(data);
});

app.get("/api/jobs/:id/video",async(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job?.file) return res.status(404).send("Video not ready.");
  res.type("mp4");
  res.sendFile(job.file);
});

app.get("*",(req,res)=>res.sendFile(path.join(publicDir,"index.html")));

app.listen(PORT,()=>console.log(`Kids AI Video Creator running at http://localhost:${PORT}`));

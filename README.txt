KIDS AI VIDEO CREATOR — FINAL V2

WHAT THIS VERSION FIXES
- The frontend is served by the Node backend, so it no longer depends on opening index.html as a content:// file.
- API key stays server-side.
- Uses real AI video generation through the OpenAI Videos API.
- Generates a lesson plan, multiple animated scenes, AI narration, and burned-in captions.
- Uses ffmpeg-static, so you do NOT need to install FFmpeg separately.
- Has a /api/health diagnostic endpoint and clearer error messages.

REQUIREMENTS
- Node.js 20 or newer
- An OpenAI API key with access to the models/features used by this project.
- API usage can incur charges.

SETUP
1. Extract this ZIP on a computer.
2. Open a terminal in the project folder.
3. Run: npm install
4. Copy .env.example to .env
5. Put your API key in .env:
   OPENAI_API_KEY=your_key_here
6. Run: npm start
7. Open:
   http://localhost:3000
   IMPORTANT: Do NOT open public/index.html directly.

WHY YOUR OLD VERSION SAID "FAILED TO FETCH"
The old page was opened as content:// on the phone. That page had no running Node backend behind /api/generate. This version serves the page from Express and provides the API routes.

ABOUT PHONE USE
A phone browser cannot run the Node backend simply by opening the HTML file. For phone-only use, deploy this project to a Node-compatible server/host, then open the deployed HTTPS website. The API key remains on the server.

CURRENT VIDEO PIPELINE
Prompt → GPT lesson plan → Sora 2 scene videos → MP4 scene concat → GPT-4o mini TTS narration → narration mux → captions burned into MP4.

IMPORTANT
- Sora video generation is asynchronous and can take time.
- Video generation and audio generation are paid API operations according to the account's current pricing.
- Never put your API key into public HTML/JavaScript.

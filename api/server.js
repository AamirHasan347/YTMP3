const express = require("express");
const cors = require("cors");
const archiver = require("archiver");
const { spawn, execSync } = require("child_process");
const { URL } = require("url");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------- Check for required dependencies ----------
function checkDependencies() {
  try {
    execSync("yt-dlp --version", { stdio: "ignore" });
    console.log("✅ yt-dlp is installed.");
  } catch (e) {
    console.error("❌ yt-dlp is not installed or not in PATH.");
    console.error(
      "   Install it with: curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp",
    );
    process.exit(1);
  }
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    console.log("✅ ffmpeg is installed.");
  } catch (e) {
    console.error("❌ ffmpeg is not installed or not in PATH.");
    console.error(
      "   Install it with: apt-get update && apt-get install -y ffmpeg",
    );
    process.exit(1);
  }
}
checkDependencies();

const app = express();
app.use(express.json());

// ---------- Log every incoming request ----------
app.use((req, res, next) => {
  console.log(
    `[REQUEST] ${req.method} ${req.url} from origin: ${req.headers.origin || "none"}`,
  );
  next();
});

// ---------- CORS configuration with detailed logging ----------
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://ytmp3-five.vercel.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      console.log(`[CORS] Incoming origin: ${origin}`);
      console.log(`[CORS] Allowed origins: ${JSON.stringify(allowedOrigins)}`);

      if (!origin) {
        console.log("[CORS] No origin – allowing");
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        console.log(`[CORS] Origin ${origin} is allowed`);
        return callback(null, true);
      } else {
        console.log(`[CORS] Origin ${origin} is NOT allowed`);
        return callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Store active SSE connections: sessionId -> express.Response
const clients = new Map();

// Global error handlers
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  setTimeout(() => process.exit(1), 1000);
});

// ---------- SSE endpoint ----------
app.get("/api/progress", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).send("sessionId required");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  clients.set(sessionId, res);
  res.write(
    `event: connected\ndata: ${JSON.stringify({ message: "SSE connected" })}\n\n`,
  );

  req.on("close", () => {
    clients.delete(sessionId);
    res.end();
  });
});

function sendEvent(sessionId, event, data) {
  const client = clients.get(sessionId);
  if (client) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// ---------- Main processing endpoint ----------
app.post("/api/process-url", async (req, res) => {
  const { url, sessionId } = req.body;
  if (!url || !sessionId) {
    return res.status(400).json({ error: "url and sessionId required" });
  }

  try {
    const playlistId = extractPlaylistId(url);
    if (!playlistId) {
      throw new Error("Invalid YouTube Music playlist URL");
    }

    sendEvent(sessionId, "status", { message: "Fetching playlist info..." });

    const playlistInfo = await getPlaylistInfo(playlistId);
    const totalSongs = playlistInfo.length;
    if (totalSongs === 0) {
      throw new Error("No songs found in playlist");
    }

    sendEvent(sessionId, "playlistInfo", { total: totalSongs });

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("Archiver error:", err);
      sendEvent(sessionId, "error", { message: "ZIP creation failed" });
      res.end();
    });

    res.attachment("songs.zip");
    archive.pipe(res);

    const tempFiles = [];

    for (let i = 0; i < totalSongs; i++) {
      const song = playlistInfo[i];
      const safeName = sanitizeFilename(song.title) + ".mp3";
      const tempFilePath = path.join(os.tmpdir(), `${uuidv4()}.mp3`);

      console.log(`[${i + 1}/${totalSongs}] Processing: ${song.title}`);

      sendEvent(sessionId, "songStart", {
        current: i + 1,
        total: totalSongs,
        title: song.title,
      });

      try {
        await downloadSongToFile(song.id, tempFilePath, (progress) => {
          sendEvent(sessionId, "songProgress", {
            current: i + 1,
            total: totalSongs,
            songTitle: song.title,
            percent: progress,
          });
        });

        archive.file(tempFilePath, { name: safeName });
        tempFiles.push(tempFilePath);
        console.log(`  ✅ Added: ${song.title}`);
      } catch (songError) {
        console.error(`  ❌ Failed: ${song.title} – ${songError.message}`);
        sendEvent(sessionId, "songError", {
          current: i + 1,
          total: totalSongs,
          title: song.title,
          error: songError.message,
        });
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch (cleanupErr) {
          console.error("Error cleaning up temp file:", cleanupErr);
        }
      }

      console.log(`  Waiting 1.5s before next song...`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    console.log("Finalizing archive...");
    await archive.finalize();
    sendEvent(sessionId, "complete", { message: "Download finished" });

    for (const file of tempFiles) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (err) {
        console.error("Error deleting temp file:", err);
      }
    }
    console.log("Done.");
  } catch (error) {
    console.error("Processing error:", error);
    sendEvent(sessionId, "error", { message: error.message });
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// ---------- Helper functions ----------

function extractPlaylistId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("list");
  } catch {
    return null;
  }
}

function getPlaylistInfo(playlistId) {
  return new Promise((resolve, reject) => {
    const playlistUrl = `https://music.youtube.com/playlist?list=${playlistId}`;
    const ytproc = spawn("yt-dlp", [
      "--flat-playlist",
      "--dump-json",
      playlistUrl,
    ]);

    let output = "";
    let errorOutput = "";

    ytproc.stdout.on("data", (chunk) => {
      output += chunk;
    });
    ytproc.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });

    ytproc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp failed: ${errorOutput}`));
      }
      const lines = output
        .trim()
        .split("\n")
        .filter((l) => l);
      const videos = lines
        .map((line) => {
          try {
            const data = JSON.parse(line);
            return { id: data.id, title: data.title };
          } catch {
            return null;
          }
        })
        .filter((v) => v !== null);
      resolve(videos);
    });
  });
}

function downloadSongToFile(videoId, outputPath, progressCallback) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const videoUrl = `https://music.youtube.com/watch?v=${videoId}`;

    const ytproc = spawn("yt-dlp", ["-f", "bestaudio", "-o", "-", videoUrl]);
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      "pipe:0",
      "-f",
      "mp3",
      "-ab",
      "192k",
      "-y",
      outputPath,
      "-loglevel",
      "error",
    ]);

    ytproc.stdout.pipe(ffmpeg.stdin);

    let ytError = "";
    let ffmpegError = "";

    ytproc.stderr.on("data", (chunk) => {
      const line = chunk.toString();
      ytError += line;
      const percentMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (percentMatch && progressCallback && !settled) {
        progressCallback(parseFloat(percentMatch[1]));
      }
    });

    ffmpeg.stderr.on("data", (chunk) => {
      ffmpegError += chunk.toString();
    });

    const cleanup = () => {
      ytproc.kill();
      ffmpeg.kill();
    };

    const handleError = (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    ytproc.on("error", handleError);
    ffmpeg.on("error", handleError);

    ytproc.on("close", (code) => {
      if (code !== 0 && !settled) {
        handleError(new Error(`yt-dlp exited with code ${code}: ${ytError}`));
      }
    });

    ffmpeg.on("close", (code) => {
      if (!settled) {
        if (code !== 0) {
          handleError(
            new Error(`ffmpeg exited with code ${code}: ${ffmpegError}`),
          );
        } else {
          settled = true;
          resolve();
        }
      }
    });
  });
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = app;

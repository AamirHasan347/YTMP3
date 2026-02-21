import React, { useState, useEffect, useRef } from "react";

// Use Vite's environment variable – set VITE_API_BASE_URL in .env or Vercel
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

function App() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [currentSong, setCurrentSong] = useState("");

  const [sessionId, setSessionId] = useState("");
  useEffect(() => {
    setSessionId(crypto.randomUUID());
  }, []);

  const eventSourceRef = useRef(null);

  const handleProcess = async (e) => {
    e.preventDefault();
    if (!url.trim()) {
      setMessage("Please enter a valid URL.");
      return;
    }

    setIsLoading(true);
    setProgress(0);
    setCurrentSong("");
    setMessage("Connecting...");

    const eventSource = new EventSource(
      `${API_BASE_URL}/api/progress?sessionId=${sessionId}`,
    );
    eventSourceRef.current = eventSource;

    let totalSongs = 0;

    eventSource.addEventListener("playlistInfo", (e) => {
      const data = JSON.parse(e.data);
      totalSongs = data.total;
      setMessage(`Found ${totalSongs} songs. Starting download...`);
    });

    eventSource.addEventListener("songStart", (e) => {
      const data = JSON.parse(e.data);
      setCurrentSong(data.title);
      setMessage(`Downloading (${data.current}/${data.total}): ${data.title}`);
    });

    eventSource.addEventListener("songProgress", (e) => {
      try {
        const data = JSON.parse(e.data);
        const overall =
          ((data.current - 1 + data.percent / 100) / data.total) * 100;
        setProgress(Math.min(overall, 100));
      } catch (err) {
        console.warn("Invalid progress JSON:", e.data);
      }
    });

    eventSource.addEventListener("songError", (e) => {
      const data = JSON.parse(e.data);
      setMessage(`Skipped: ${data.title} – ${data.error}`);
    });

    eventSource.addEventListener("error", (e) => {
      const data = JSON.parse(e.data);
      setMessage(`Error: ${data.message}`);
      setIsLoading(false);
      eventSource.close();
    });

    eventSource.addEventListener("complete", () => {
      setMessage("Download complete!");
      setProgress(100);
    });

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.message) setMessage(data.message);
      } catch {
        // ignore non‑JSON messages
      }
    };

    try {
      const response = await fetch(`${API_BASE_URL}/api/process-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, sessionId }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to process URL");
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.setAttribute("download", "songs.zip");
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      setMessage("Success! Check your downloads.");
    } catch (error) {
      console.error("Error:", error);
      setMessage(`An error occurred: ${error.message}`);
      if (eventSourceRef.current) eventSourceRef.current.close();
    } finally {
      setIsLoading(false);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setTimeout(() => setProgress(0), 3000);
    }
  };

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-md p-6 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-4 text-center">
          YouTube Music Playlist Downloader
        </h1>

        <form onSubmit={handleProcess} className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Paste YouTube Music playlist URL..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isLoading}
            className="w-full p-3 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <button
            type="submit"
            disabled={isLoading}
            className={`w-full p-3 text-white font-semibold rounded transition-colors ${
              isLoading
                ? "bg-blue-300 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {isLoading ? "Processing..." : "Download Playlist"}
          </button>
        </form>

        {isLoading && (
          <div className="mt-6">
            <div className="flex justify-between text-sm font-medium text-gray-700 mb-1">
              <span>{currentSong ? currentSong : "Preparing..."}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
          </div>
        )}

        {message && (
          <p className="mt-4 text-center text-sm font-medium text-gray-700">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

export default App;

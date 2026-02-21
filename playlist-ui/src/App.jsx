import React, { useState, useEffect, useRef } from "react";

function App() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0); // overall % (0–100)
  const [message, setMessage] = useState("");
  const [currentSong, setCurrentSong] = useState(""); // title being processed

  // Generate a unique session ID once when the component mounts
  const [sessionId, setSessionId] = useState("");
  useEffect(() => {
    setSessionId(crypto.randomUUID());
  }, []);

  // Ref to hold the EventSource so we can close it properly
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

    // 1. Open SSE connection with the session ID
    const eventSource = new EventSource(
      `http://localhost:3001/api/progress?sessionId=${sessionId}`,
    );
    eventSourceRef.current = eventSource;

    // Store total songs count for progress calculation
    let totalSongs = 0;

    // Listen for the playlist info event
    eventSource.addEventListener("playlistInfo", (e) => {
      const data = JSON.parse(e.data);
      totalSongs = data.total;
      setMessage(`Found ${totalSongs} songs. Starting download...`);
    });

    // When a new song starts
    eventSource.addEventListener("songStart", (e) => {
      const data = JSON.parse(e.data);
      setCurrentSong(data.title);
      setMessage(`Downloading (${data.current}/${data.total}): ${data.title}`);
    });

    // Update progress based on current song's percentage
    eventSource.addEventListener("songProgress", (e) => {
      const data = JSON.parse(e.data);
      // overall progress = ( (current-1) + (data.percent/100) ) / total * 100
      const overall =
        ((data.current - 1 + data.percent / 100) / data.total) * 100;
      setProgress(Math.min(overall, 100));
    });

    // If an error occurs during processing
    eventSource.addEventListener("error", (e) => {
      const data = JSON.parse(e.data);
      setMessage(`Error: ${data.message}`);
      setIsLoading(false);
      eventSource.close();
    });

    // When everything is done (ZIP is ready)
    eventSource.addEventListener("complete", () => {
      setMessage("Download complete!");
      setProgress(100);
      // Don't close yet – the ZIP will be delivered via the POST response
    });

    // Fallback for any other messages (like connected)
    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.message) setMessage(data.message);
    };

    // 2. Send the POST request to start the actual download
    try {
      const response = await fetch("http://localhost:3001/api/process-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, sessionId }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to process URL");
      }

      // Get the ZIP blob and trigger download
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
      // Close SSE on error
      if (eventSourceRef.current) eventSourceRef.current.close();
    } finally {
      setIsLoading(false);
      // Close SSE if still open
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      // Reset progress after a few seconds
      setTimeout(() => setProgress(0), 3000);
    }
  };

  // Cleanup on unmount
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

        {/* Progress bar and current song info */}
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

        {/* Status message */}
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

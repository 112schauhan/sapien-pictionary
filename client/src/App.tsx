import React, { useEffect, useRef, useState } from "react"
import { Canvas } from "./Canvas"
import {
  type PlayerData,
  type ChatMessage,
  type StrokePayload,
  GAME_CONSTANTS,
} from "./types"

export default function App() {
  const [name, setName] = useState("")
  const [roomId, setRoomId] = useState(GAME_CONSTANTS.DEFAULT_ROOM_ID)
  const [roundsInput, setRoundsInput] = useState(3)
  const [drawTimeInput, setDrawTimeInput] = useState(60)
  const [joined, setJoined] = useState(false)
  const [playerId] = useState(
    () => "usr_" + Math.random().toString(36).substring(2, 9),
  )

  const [players, setPlayers] = useState<PlayerData[]>([])
  const [gameStatus, setGameStatus] = useState("lobby")
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [choices, setChoices] = useState<string[]>([])
  const [timer, setTimer] = useState(0)
  const [headerHint, setHeaderHint] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [historyCache, setHistoryCache] = useState<StrokePayload[]>([])
  const [chatBox, setChatBox] = useState("")

  const wsRef = useRef<WebSocket | null>(null)
  const canvasCallbackRef = useRef<((stroke: StrokePayload) => void) | null>(
    null,
  )

  const runStrokeReplaySimulation = (fullReplayData: StrokePayload[]) => {
    setGameStatus("replaying")

    if (canvasCallbackRef.current) {
      canvasCallbackRef.current({
        tool: "clear",
        points: [],
        color: "",
        size: 0,
      })
    }

    let index = 0
    const playNextStroke = () => {
      if (index >= fullReplayData.length) {
        setGameStatus("ended")
        return
      }

      if (canvasCallbackRef.current) {
        canvasCallbackRef.current(fullReplayData[index])
      }
      index++
      setTimeout(playNextStroke, 80)
    }

    if (fullReplayData.length > 0) {
      playNextStroke()
    } else {
      setGameStatus("ended")
    }
  }

  useEffect(() => {
    if (!joined) return

    const socket = new WebSocket(GAME_CONSTANTS.SERVER_WS_URL)
    wsRef.current = socket

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "join_room",
          roomId,
          playerId,
          name,
          payload: {
            hostSettings: { rounds: roundsInput, drawTime: drawTimeInput },
          },
        }),
      )
    }

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data)
      switch (data.type) {
        case "sync_state":
          setPlayers(data.payload.roomState.players)
          setGameStatus(data.payload.roomState.game_status)
          setDrawerId(data.payload.roomState.current_drawer_id)
          setHistoryCache(data.payload.history)
          break
        case "room_updated":
          setPlayers(data.payload)
          break
        case "turn_choosing":
          setGameStatus("choosing")
          setDrawerId(data.payload.drawerId)
          setChoices(data.payload.choices)
          break
        case "drawing_started":
          setGameStatus("drawing")
          break
        case "timer_tick":
          setTimer(data.payload.timer)
          setHeaderHint(data.payload.hint)
          break
        case "stroke":
          if (canvasCallbackRef.current) canvasCallbackRef.current(data.payload)
          break
        case "chat_message":
          setMessages((prev) => [
            ...prev,
            { sender: data.payload.sender, text: data.payload.text },
          ])
          break
        case "system_message":
          setMessages((prev) => [
            ...prev,
            { system: true, text: data.payload.text },
          ])
          break
        case "turn_ended":
          setGameStatus("ended")
          setMessages((prev) => [
            ...prev,
            {
              system: true,
              text: `Round over! Word was: ${data.payload.word}`,
            },
          ])
          break
        case "game_over":
          setMessages((prev) => [
            ...prev,
            {
              system: true,
              text: "🏁 Game Over! Commencing stroke replays...",
            },
          ])
          runStrokeReplaySimulation(data.payload.replay)
          break
      }
    }

    return () => socket.close()
  }, [joined, roomId, playerId, name, roundsInput, drawTimeInput])

  const fireChatMessage = (e: React.FormEvent) => {
    e.preventDefault()
    if (!chatBox.trim()) return
    wsRef.current?.send(
      JSON.stringify({
        type: "guess",
        roomId,
        playerId,
        payload: { text: chatBox },
      }),
    )
    setChatBox("")
  }

  if (!joined) {
    return (
      <div
        style={{
          padding: "30px",
          fontFamily: "Segoe UI",
          textAlign: "center",
          maxWidth: "350px",
          margin: "50px auto",
          border: "1px solid #ccc",
          borderRadius: "8px",
          background: "#fdfdfd",
        }}
      >
        <h3>🎮 Pictionary Studio</h3>
        <input
          type="text"
          placeholder="Your Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: "90%", padding: "8px", marginBottom: "10px" }}
        />
        <input
          type="text"
          placeholder="Room ID"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          style={{ width: "90%", padding: "8px", marginBottom: "15px" }}
        />

        <label
          style={{
            fontSize: "12px",
            textAlign: "left",
            display: "block",
            margin: "5px 0 2px 15px",
          }}
        >
          Number of Rounds:
        </label>
        <input
          type="number"
          min="1"
          max="10"
          value={roundsInput}
          onChange={(e) => setRoundsInput(Number(e.target.value))}
          style={{ width: "90%", padding: "8px", marginBottom: "10px" }}
        />

        <label
          style={{
            fontSize: "12px",
            textAlign: "left",
            display: "block",
            margin: "5px 0 2px 15px",
          }}
        >
          Draw Time (seconds):
        </label>
        <input
          type="number"
          min="20"
          max="180"
          value={drawTimeInput}
          onChange={(e) => setDrawTimeInput(Number(e.target.value))}
          style={{ width: "90%", padding: "8px", marginBottom: "25px" }}
        />

        <button
          type="button"
          onClick={() => name.trim() && setJoined(true)}
          style={{
            width: "96%",
            padding: "12px",
            background: "#28a745",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: "bold",
          }}
        >
          Enter Lounge
        </button>
      </div>
    )
  }

  const isDrawer = drawerId === playerId

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr 280px",
        gap: "20px",
        padding: "20px",
        fontFamily: "Segoe UI",
      }}
    >
      <div
        style={{
          background: "#f8f9fa",
          padding: "15px",
          borderRadius: "6px",
          border: "1px solid #ddd",
        }}
      >
        <h4>Players Roster</h4>
        {players.map((p) => (
          <div key={p.id} style={{ marginBottom: "10px", fontSize: "14px" }}>
            {p.name} {p.is_host && "⭐"} — <strong>{p.score}</strong>{" "}
            {p.id === drawerId && "✏️"} {p.is_correct && "✅"}
          </div>
        ))}
        {gameStatus === "lobby" &&
          players.find((p) => p.id === playerId)?.is_host && (
            <button
              type="button"
              onClick={() =>
                wsRef.current?.send(
                  JSON.stringify({ type: "start_game", roomId, playerId }),
                )
              }
              style={{
                marginTop: "20px",
                width: "100%",
                padding: "8px",
                cursor: "pointer",
              }}
            >
              Start Game
            </button>
          )}
      </div>

      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "10px",
          }}
        >
          <h4>
            Room Code: {roomId}{" "}
            {timer > 0 && <span style={{ color: "crimson" }}>({timer}s)</span>}
          </h4>
          <div
            style={{
              fontSize: "22px",
              letterSpacing: "4px",
              fontWeight: "bold",
            }}
          >
            {gameStatus === "replaying" ? "🎬 REPLAYING MATCH" : headerHint}
          </div>
        </div>

        {gameStatus === "choosing" && isDrawer && (
          <div
            style={{
              background: "#fff3cd",
              padding: "15px",
              borderRadius: "6px",
              textAlign: "center",
              marginBottom: "10px",
            }}
          >
            <h5>Select a word to draw:</h5>
            {choices.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() =>
                  wsRef.current?.send(
                    JSON.stringify({
                      type: "word_chosen",
                      roomId,
                      playerId,
                      payload: { word: w },
                    }),
                  )
                }
                style={{
                  margin: "4px",
                  padding: "6px 12px",
                  cursor: "pointer",
                }}
              >
                {w}
              </button>
            ))}
          </div>
        )}

        <Canvas
          isDrawer={isDrawer && gameStatus === "drawing"}
          onStrokeEmitted={(s) =>
            wsRef.current?.send(
              JSON.stringify({ type: "stroke", roomId, playerId, payload: s }),
            )
          }
          initialHistory={historyCache}
          onStrokeReceivedRef={canvasCallbackRef}
        />
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "470px",
          border: "1px solid #ddd",
          borderRadius: "6px",
          padding: "10px",
          background: "#fdfdfd",
        }}
      >
        <h4>Chat & Guesses</h4>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            fontSize: "13px",
            marginBottom: "10px",
          }}
        >
          {messages.map((m, idx) => (
            <div
              key={idx}
              style={{
                color: m.system ? "green" : "#000",
                marginBottom: "4px",
              }}
            >
              {!m.system && <strong>{m.sender}: </strong>} {m.text}
            </div>
          ))}
        </div>
        <form onSubmit={fireChatMessage}>
          <input
            type="text"
            value={chatBox}
            onChange={(e) => setChatBox(e.target.value)}
            disabled={
              (isDrawer && gameStatus === "drawing") ||
              gameStatus === "replaying"
            }
            placeholder={
              isDrawer
                ? "You are drawing!"
                : gameStatus === "replaying"
                  ? "Viewing replay..."
                  : "Type guess..."
            }
            style={{ width: "92%", padding: "8px" }}
          />
        </form>
      </div>
    </div>
  )
}

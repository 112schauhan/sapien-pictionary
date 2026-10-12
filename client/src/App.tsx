import React, { useEffect, useRef, useState } from "react"
import { Canvas } from "./Canvas"
import {
  type PlayerData,
  type ChatMessage,
  type StrokePayload,
  type RoomConfig,
  type RoomLookup,
  GAME_CONSTANTS,
  getOrCreatePlayerId,
  randomRoomId,
} from "./types"
import "./App.css"

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const [name, setName] = useState(
    () => localStorage.getItem("sapien_pictionary_name") || "",
  )
  const [roomId, setRoomId] = useState(
    () => params.get("room") || GAME_CONSTANTS.DEFAULT_ROOM_ID,
  )
  const [roundsInput, setRoundsInput] = useState(3)
  const [drawTimeInput, setDrawTimeInput] = useState(60)
  const [wordListText, setWordListText] = useState("")
  const [joined, setJoined] = useState(false)
  const [playerId] = useState(() => getOrCreatePlayerId())
  const [linkCopied, setLinkCopied] = useState(false)
  const [roomLookup, setRoomLookup] = useState<RoomLookup | null>(null)
  const [roomLookupLoading, setRoomLookupLoading] = useState(false)

  const [players, setPlayers] = useState<PlayerData[]>([])
  const [gameStatus, setGameStatus] = useState("lobby")
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [choices, setChoices] = useState<string[]>([])
  const [timer, setTimer] = useState(0)
  const [headerHint, setHeaderHint] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [historyCache, setHistoryCache] = useState<StrokePayload[]>([])
  const [chatBox, setChatBox] = useState("")
  const [roomConfig, setRoomConfig] = useState<RoomConfig>({
    totalRounds: 3,
    drawTime: 60,
    currentRound: 1,
    wordListSize: 0,
  })
  const [ranking, setRanking] = useState<PlayerData[]>([])
  const [revealedWord, setRevealedWord] = useState<string | null>(null)
  const [mobileTab, setMobileTab] = useState<"players" | "chat">("chat")

  const wsRef = useRef<WebSocket | null>(null)
  const canvasCallbackRef = useRef<((stroke: StrokePayload) => void) | null>(
    null,
  )
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const replayTimerRef = useRef<number | null>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Probe whether the room already exists so joiners see host settings as read-only
  useEffect(() => {
    if (joined) return

    const trimmed = roomId.trim()
    if (!trimmed) {
      setRoomLookup(null)
      setRoomLookupLoading(false)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setRoomLookupLoading(true)
      try {
        const res = await fetch(
          `${GAME_CONSTANTS.SERVER_HTTP_URL}/rooms/${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        )
        if (!res.ok) {
          setRoomLookup({ exists: false })
          return
        }
        const data = (await res.json()) as RoomLookup
        setRoomLookup(data)
        if (data.exists) {
          if (typeof data.totalRounds === "number") setRoundsInput(data.totalRounds)
          if (typeof data.drawTime === "number") setDrawTimeInput(data.drawTime)
          // Word list content stays on the server; show size only
          if (!data.wordListSize) setWordListText("")
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setRoomLookup(null)
        }
      } finally {
        if (!controller.signal.aborted) setRoomLookupLoading(false)
      }
    }, 250)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [roomId, joined])

  const pushSystem = (text: string) => {
    setMessages((prev) => [...prev, { system: true, text }])
  }

  const runStrokeReplaySimulation = (fullReplayData: StrokePayload[]) => {
    setGameStatus("replaying")
    if (replayTimerRef.current) {
      window.clearTimeout(replayTimerRef.current)
    }
    canvasCallbackRef.current?.({
      tool: "clear",
      points: [],
      color: "",
      size: 0,
    })

    let index = 0
    const playNext = () => {
      if (index >= fullReplayData.length) {
        setGameStatus("game_over")
        return
      }
      canvasCallbackRef.current?.(fullReplayData[index])
      index++
      replayTimerRef.current = window.setTimeout(playNext, 70)
    }

    if (fullReplayData.length > 0) playNext()
    else setGameStatus("game_over")
  }

  useEffect(() => {
    if (!joined) return

    const socket = new WebSocket(GAME_CONSTANTS.SERVER_WS_URL)
    wsRef.current = socket

    socket.onopen = () => {
      const wordList = wordListText
        .split(/[\n,]/)
        .map((w) => w.trim())
        .filter(Boolean)
      socket.send(
        JSON.stringify({
          type: "join_room",
          roomId,
          playerId,
          name,
          payload: {
            hostSettings: {
              rounds: roundsInput,
              drawTime: drawTimeInput,
              wordList: wordList.length ? wordList : undefined,
            },
          },
        }),
      )
    }

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data)
      switch (data.type) {
        case "sync_state": {
          const rs = data.payload.roomState
          setPlayers(rs.players)
          setGameStatus(rs.game_status)
          setDrawerId(rs.current_drawer_id)
          setHistoryCache(data.payload.history || [])
          setTimer(rs.timer || 0)
          setHeaderHint(rs.hint || "")
          setRoomConfig({
            totalRounds: rs.total_rounds,
            drawTime: rs.draw_time,
            currentRound: rs.current_round,
            wordListSize: rs.word_list_size || 0,
          })
          if (rs.game_status === "lobby") setRevealedWord(null)
          break
        }
        case "room_updated":
          setPlayers(data.payload)
          break
        case "turn_choosing":
          setGameStatus("choosing")
          setDrawerId(data.payload.drawerId)
          setChoices(data.payload.choices || [])
          setTimer(0)
          setHeaderHint("")
          setRevealedWord(null)
          setHistoryCache([])
          setRoomConfig((c) => ({
            ...c,
            currentRound: data.payload.round ?? c.currentRound,
            totalRounds: data.payload.totalRounds ?? c.totalRounds,
          }))
          canvasCallbackRef.current?.({
            tool: "clear",
            points: [],
            color: "",
            size: 0,
          })
          break
        case "drawing_started":
          setGameStatus("drawing")
          setDrawerId(data.payload.drawerId ?? drawerId)
          setTimer(data.payload.timer)
          setChoices([])
          setRevealedWord(null)
          setRoomConfig((c) => ({
            ...c,
            currentRound: data.payload.round ?? c.currentRound,
            totalRounds: data.payload.totalRounds ?? c.totalRounds,
          }))
          break
        case "timer_tick":
          setTimer(data.payload.timer)
          setHeaderHint(data.payload.hint)
          if (data.payload.round) {
            setRoomConfig((c) => ({
              ...c,
              currentRound: data.payload.round,
              totalRounds: data.payload.totalRounds ?? c.totalRounds,
            }))
          }
          break
        case "stroke":
          canvasCallbackRef.current?.(data.payload)
          break
        case "chat_message":
          setMessages((prev) => [
            ...prev,
            { sender: data.payload.sender, text: data.payload.text },
          ])
          break
        case "system_message":
          pushSystem(data.payload.text)
          break
        case "close_guess":
          setMessages((prev) => [
            ...prev,
            { system: true, close: true, text: data.payload.text || "Close!" },
          ])
          break
        case "turn_ended":
          setGameStatus("turn_ended")
          setRevealedWord(data.payload.word)
          setHeaderHint(data.payload.word || "")
          pushSystem(`Round over! The word was “${data.payload.word}”.`)
          break
        case "game_over":
          setRanking(data.payload.ranking || [])
          setRevealedWord(data.payload.word || null)
          pushSystem("Game over — replaying every stroke…")
          runStrokeReplaySimulation(data.payload.replay || [])
          break
      }
    }

    socket.onclose = () => {
      pushSystem("Disconnected from server. Refresh to rejoin.")
    }

    return () => {
      if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current)
      socket.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined])

  const send = (type: string, payload: unknown = {}) => {
    wsRef.current?.send(
      JSON.stringify({ type, roomId, playerId, name, payload }),
    )
  }

  const fireChatMessage = (e: React.FormEvent) => {
    e.preventDefault()
    if (!chatBox.trim()) return
    send("guess", { text: chatBox })
    setChatBox("")
  }

  const copyInviteLink = async () => {
    const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setLinkCopied(true)
      window.setTimeout(() => setLinkCopied(false), 2000)
    } catch {
      prompt("Copy this invite link:", inviteUrl)
    }
  }

  const enterRoom = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    localStorage.setItem("sapien_pictionary_name", trimmed)
    const url = new URL(window.location.href)
    url.searchParams.set("room", roomId)
    window.history.replaceState({}, "", url.toString())
    setJoined(true)
  }

  const activeUser = players.find((p) => p.id === playerId)
  const isHost = activeUser?.is_host || false
  const isDrawer = drawerId === playerId
  const drawerName = players.find((p) => p.id === drawerId)?.name
  const joiningExisting = Boolean(roomLookup?.exists)
  const settingsLocked = joiningExisting

  if (!joined) {
    return (
      <div className="shell lobby-shell">
        <div className="atmosphere" aria-hidden />
        <main className="lobby-card">
          <p className="brand">Sapien Draw</p>
          <h1>Draw it. Guess it. Own the board.</h1>
          <p className="lede">
            Real-time multiplayer pictionary — share a link, pick a word, race
            the clock.
          </p>

          <label className="field">
            <span>Your name</span>
            <input
              type="text"
              maxLength={20}
              placeholder="Artist name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && enterRoom()}
            />
          </label>

          <label className="field">
            <span>Room code</span>
            <div className="room-row">
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.trim())}
              />
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setRoomId(randomRoomId())}
              >
                New
              </button>
            </div>
          </label>

          <div
            className={[
              "room-status",
              joiningExisting ? "existing" : "new",
              roomLookupLoading ? "loading" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {roomLookupLoading
              ? "Checking room…"
              : joiningExisting
                ? `Joining existing room · ${roomLookup?.playerCount ?? 0} player${
                    (roomLookup?.playerCount ?? 0) === 1 ? "" : "s"
                  } · host settings locked`
                : "Creating a new room — you set the rules"}
          </div>

          <div className={`settings-grid ${settingsLocked ? "locked" : ""}`}>
            <label className="field">
              <span>Rounds</span>
              <input
                type="number"
                min={1}
                max={10}
                value={roundsInput}
                disabled={settingsLocked}
                readOnly={settingsLocked}
                onChange={(e) => setRoundsInput(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Draw time (s)</span>
              <input
                type="number"
                min={20}
                max={180}
                value={drawTimeInput}
                disabled={settingsLocked}
                readOnly={settingsLocked}
                onChange={(e) => setDrawTimeInput(Number(e.target.value))}
              />
            </label>
          </div>

          <label className="field">
            <span>Custom word list (optional)</span>
            <textarea
              rows={3}
              placeholder={
                settingsLocked
                  ? roomLookup?.wordListSize
                    ? `Host word list (${roomLookup.wordListSize} words)`
                    : "Host is using the default word list"
                  : "comma or newline separated — you become the host"
              }
              value={settingsLocked ? "" : wordListText}
              disabled={settingsLocked}
              readOnly={settingsLocked}
              onChange={(e) => setWordListText(e.target.value)}
            />
          </label>

          <button type="button" className="primary-btn" onClick={enterRoom}>
            {joiningExisting ? "Join room" : "Create & enter"}
          </button>
        </main>
      </div>
    )
  }

  const sortedPlayers = [...players].sort((a, b) => b.score - a.score)
  const timerUrgent = timer > 0 && timer <= 10

  return (
    <div className="shell game-shell">
      <div className="atmosphere" aria-hidden />

      <header className="topbar">
        <div className="brand-inline">
          <span className="brand">Sapien Draw</span>
          <span className="room-chip">
            <span className="room-chip-id">{roomId}</span>
            <button type="button" onClick={copyInviteLink}>
              {linkCopied ? "Copied" : "Share"}
            </button>
          </span>
        </div>
        <div className="round-meta">
          <span className="round-label">
            Round {roomConfig.currentRound}/{roomConfig.totalRounds}
          </span>
          <span className={`timer ${timerUrgent ? "urgent" : ""}`}>
            {gameStatus === "drawing" || gameStatus === "turn_ended"
              ? `${timer}s`
              : `${roomConfig.drawTime}s`}
          </span>
        </div>
      </header>

      <div className={`game-grid mobile-tab-${mobileTab}`}>
        <aside className="panel players-panel">
          <div className="panel-head">
            <h2>Players</h2>
            <span className="panel-count">{players.length}</span>
          </div>
          <ul className="player-list">
            {sortedPlayers.map((p, i) => (
              <li
                key={p.id}
                className={[
                  p.id === playerId ? "you" : "",
                  p.id === drawerId &&
                  (gameStatus === "drawing" || gameStatus === "choosing")
                    ? "drawing"
                    : "",
                  p.is_correct && gameStatus !== "game_over" ? "correct" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="rank">{i + 1}</span>
                <div className="player-meta">
                  <strong>
                    {p.name}
                    {p.is_host ? " · host" : ""}
                    {p.id === playerId ? " · you" : ""}
                  </strong>
                  <small>
                    {gameStatus === "game_over" || gameStatus === "replaying"
                      ? "Done"
                      : p.id === drawerId &&
                          (gameStatus === "drawing" ||
                            gameStatus === "choosing")
                        ? "Drawing"
                        : p.is_correct
                          ? "Guessed"
                          : "Guessing"}
                  </small>
                </div>
                <span className="score">{p.score}</span>
              </li>
            ))}
          </ul>

          {gameStatus === "lobby" && isHost && (
            <div className="lobby-host-controls">
              <div className="settings-grid compact">
                <label className="field">
                  <span>Rounds</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={roomConfig.totalRounds}
                    onChange={(e) => {
                      const rounds = Number(e.target.value)
                      setRoomConfig((c) => ({ ...c, totalRounds: rounds }))
                      send("update_settings", { rounds })
                    }}
                  />
                </label>
                <label className="field">
                  <span>Draw time</span>
                  <input
                    type="number"
                    min={20}
                    max={180}
                    value={roomConfig.drawTime}
                    onChange={(e) => {
                      const drawTime = Number(e.target.value)
                      setRoomConfig((c) => ({ ...c, drawTime }))
                      send("update_settings", { drawTime })
                    }}
                  />
                </label>
              </div>
              <label className="field">
                <span>Word list (optional)</span>
                <textarea
                  rows={2}
                  placeholder="comma or newline separated"
                  value={wordListText}
                  onChange={(e) => setWordListText(e.target.value)}
                  onBlur={() => {
                    const wordList = wordListText
                      .split(/[\n,]/)
                      .map((w) => w.trim())
                      .filter(Boolean)
                    send("update_settings", {
                      wordList: wordList.length ? wordList : undefined,
                    })
                  }}
                />
              </label>
              <button
                type="button"
                className="primary-btn"
                onClick={() => send("start_game")}
                disabled={players.length < 2}
              >
                {players.length < 2 ? "Waiting for players…" : "Start game"}
              </button>
            </div>
          )}
          {gameStatus === "lobby" && !isHost && (
            <p className="hint-text">
              Waiting for host to start…
              <br />
              {roomConfig.totalRounds} rounds · {roomConfig.drawTime}s draw
              {roomConfig.wordListSize
                ? ` · ${roomConfig.wordListSize} words`
                : ""}
            </p>
          )}
          {gameStatus === "game_over" && isHost && (
            <button
              type="button"
              className="primary-btn"
              onClick={() => send("reset_game")}
            >
              Play again
            </button>
          )}
        </aside>

        <section className="stage">
          <div className="hint-bar">
            <div className="hint-word">
              {gameStatus === "replaying"
                ? "Replay"
                : gameStatus === "game_over"
                  ? "Match over"
                  : gameStatus === "choosing"
                    ? isDrawer
                      ? "Pick a word"
                      : `${drawerName || "Someone"} is choosing…`
                    : gameStatus === "lobby"
                      ? "Lobby"
                      : headerHint || "— — —"}
            </div>
            {revealedWord && gameStatus === "turn_ended" && (
              <div className="reveal-banner">Word: {revealedWord}</div>
            )}
          </div>

          {gameStatus === "choosing" && isDrawer && (
            <div className="word-picker">
              <p>Choose a word to draw</p>
              <div className="word-choices">
                {choices.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => send("word_chosen", { word: w })}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
          )}

          {gameStatus === "game_over" && ranking.length > 0 && (
            <div className="podium">
              <h3>Final standings</h3>
              <ol>
                {ranking.map((p, i) => (
                  <li key={p.id}>
                    <span>
                      #{i + 1} {p.name}
                    </span>
                    <strong>{p.score}</strong>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <Canvas
            isDrawer={isDrawer && gameStatus === "drawing"}
            onStrokeEmitted={(s) => send("stroke", s)}
            initialHistory={historyCache}
            onStrokeReceivedRef={canvasCallbackRef}
          />
        </section>

        <aside className="panel chat-panel">
          <div className="panel-head">
            <h2>Chat</h2>
          </div>
          <div className="chat-log">
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={[
                  "chat-line",
                  m.system ? "system" : "",
                  m.close ? "close" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {!m.system && <strong>{m.sender}: </strong>}
                {m.text}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-form" onSubmit={fireChatMessage}>
            <input
              type="text"
              value={chatBox}
              maxLength={80}
              onChange={(e) => setChatBox(e.target.value)}
              disabled={
                (isDrawer && gameStatus === "drawing") ||
                gameStatus === "replaying" ||
                gameStatus === "game_over"
              }
              placeholder={
                isDrawer && gameStatus === "drawing"
                  ? "You’re drawing"
                  : gameStatus === "replaying"
                    ? "Replay in progress…"
                    : gameStatus === "game_over"
                      ? "Game over"
                      : "Type a guess…"
              }
            />
            <button type="submit" className="ghost-btn">
              Send
            </button>
          </form>
        </aside>

        <div className="mobile-tabs" role="tablist" aria-label="Side panels">
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "players"}
            className={mobileTab === "players" ? "active" : ""}
            onClick={() => setMobileTab("players")}
          >
            Players ({players.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "chat"}
            className={mobileTab === "chat" ? "active" : ""}
            onClick={() => setMobileTab("chat")}
          >
            Chat
          </button>
        </div>
      </div>
    </div>
  )
}

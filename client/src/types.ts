export interface Point {
  x: number
  y: number
}

export type StrokeTool = "pen" | "eraser" | "undo" | "clear" | "fill"
export type StrokePhase = "begin" | "move" | "end"

export interface StrokePayload {
  points: Point[]
  color: string
  size: number
  tool: StrokeTool
  strokeId?: string
  phase?: StrokePhase
  seq?: number
}

export interface PlayerData {
  id: string
  name: string
  score: number
  is_host: boolean
  is_correct: boolean
}

export interface ChatMessage {
  sender?: string
  text: string
  system?: boolean
  close?: boolean
}

export interface RoomConfig {
  totalRounds: number
  drawTime: number
  currentRound: number
  wordListSize: number
}

export interface RoomLookup {
  exists: boolean
  totalRounds?: number
  drawTime?: number
  wordListSize?: number
  playerCount?: number
  gameStatus?: string
}

export const GAME_CONSTANTS = {
  SERVER_WS_URL:
    (import.meta.env.VITE_WS_URL as string | undefined) ||
    `ws://${window.location.hostname}:8000/ws`,
  SERVER_HTTP_URL:
    (import.meta.env.VITE_API_URL as string | undefined) ||
    `http://${window.location.hostname}:8000`,
  DEFAULT_ROOM_ID: "sketch-lounge",
  CANVAS_WIDTH: 720,
  CANVAS_HEIGHT: 480,
  PLAYER_ID_KEY: "sapien_pictionary_player_id",
  STREAM_POINT_BATCH: 8,
  STREAM_INTERVAL_MS: 32,
}

export function getOrCreatePlayerId(): string {
  const existing = localStorage.getItem(GAME_CONSTANTS.PLAYER_ID_KEY)
  if (existing) return existing
  const id = "usr_" + Math.random().toString(36).slice(2, 11)
  localStorage.setItem(GAME_CONSTANTS.PLAYER_ID_KEY, id)
  return id
}

export function randomRoomId(): string {
  const adjectives = ["swift", "bright", "lucky", "cosmic", "pixel", "neon"]
  const nouns = ["fox", "wave", "spark", "ink", "cloud", "orbit"]
  const a = adjectives[Math.floor(Math.random() * adjectives.length)]
  const n = nouns[Math.floor(Math.random() * nouns.length)]
  const num = Math.floor(100 + Math.random() * 900)
  return `${a}-${n}-${num}`
}

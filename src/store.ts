// Хранилище на bun:sqlite: комнаты переживают рестарт, партии остаются в истории.
//
// Что не сериализуется и почему:
//   room.timer / room.timeoutFn — объект таймера и замыкание, их восстанавливает
//   engine.resumeRoom(room) по текущей фазе;
//   player.socketId — сокет живёт только в памяти, после рестарта все offline
//   и возвращаются по токену.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const DB_PATH = process.env.BUNKER_DB || `${process.cwd()}/data/bunker.db`;

// SQLite создаёт файл, но не каталог — делаем его сами
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS rooms (
    code       TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL,
    game_id    INTEGER NOT NULL,
    day        INTEGER NOT NULL,
    winner     TEXT,
    players    TEXT NOT NULL,
    ended_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS games_ended_at ON games(ended_at DESC);

  -- сессии: без них после рестарта cookie игрока не находит комнату
  CREATE TABLE IF NOT EXISTS sessions (
    sid       TEXT PRIMARY KEY,
    room      TEXT,
    player    TEXT,
    tab       TEXT,
    updated_at INTEGER NOT NULL
  );
`);

const SAVE_DELAY_MS = 200;
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

const insertRoom = db.prepare(
  `INSERT INTO rooms (code, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);
const removeRoomStmt = db.prepare(`DELETE FROM rooms WHERE code = ?`);
const selectRooms = db.prepare(`SELECT data FROM rooms`);
const upsertSession = db.prepare(
  `INSERT INTO sessions (sid, room, player, tab, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(sid) DO UPDATE SET room = excluded.room, player = excluded.player,
     tab = excluded.tab, updated_at = excluded.updated_at`,
);
const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE sid = ?`);
const selectSessions = db.prepare(`SELECT sid, room, player, tab FROM sessions`);
const deleteSessionsOfRoom = db.prepare(`DELETE FROM sessions WHERE room = ?`);

const insertGame = db.prepare(
  `INSERT INTO games (code, game_id, day, winner, players, ended_at) VALUES (?, ?, ?, ?, ?, ?)`,
);

function serialize(room: any): string {
  return JSON.stringify({
    ...room,
    timer: null,
    timeoutFn: null,
    // сокеты не переживают рестарт
    players: room.players.map((p: any) => ({
      ...p,
      socketId: null,
      connected: false,
      disconnectedAt: p.disconnectedAt ?? Date.now(),
    })),
  });
}

/** Сохранить комнату. Частые изменения склеиваются в одну запись. */
export function saveRoom(room: any) {
  const code = room.code;
  const existing = pendingWrites.get(code);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingWrites.delete(code);
    try {
      insertRoom.run(code, serialize(room), Date.now());
    } catch (err) {
      console.error("[store] не удалось сохранить комнату", code, err);
    }
  }, SAVE_DELAY_MS);
  // не держим процесс живым из-за отложенной записи
  (timer as any).unref?.();
  pendingWrites.set(code, timer);
}

export function saveRoomNow(room: any) {
  const existing = pendingWrites.get(room.code);
  if (existing) clearTimeout(existing);
  pendingWrites.delete(room.code);
  try {
    insertRoom.run(room.code, serialize(room), Date.now());
  } catch (err) {
    console.error("[store] запись комнаты не удалась", room.code, err);
  }
}

export function dropRoom(code: string) {
  const existing = pendingWrites.get(code);
  if (existing) clearTimeout(existing);
  pendingWrites.delete(code);
  try {
    removeRoomStmt.run(code);
  } catch (err) {
    console.error("[store] не удалось удалить комнату", code, err);
  }
}

/** Все сохранённые комнаты (объекты без таймеров, игроки offline). */
export function loadRooms(): any[] {
  try {
    return selectRooms
      .all()
      .map((row: any) => {
        try {
          return JSON.parse(row.data);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error("[store] не удалось прочитать комнаты", err);
    return [];
  }
}

/** Записать завершённую партию в историю (один раз на игру). */
export function saveGame(room: any) {
  try {
    insertGame.run(
      room.code,
      room.gameId,
      room.day,
      room.winner ?? null,
      JSON.stringify(
        room.players.map((p: any) => ({
          name: p.name,
          role: p.role,
          alive: p.alive,
          death: p.death,
        })),
      ),
      Date.now(),
    );
  } catch (err) {
    console.error("[store] не удалось записать историю партии", err);
  }
}

export function lastGames(limit = 10): any[] {
  try {
    return db
      .query(
        // наружу отдаём без состава: имена и роли остаются в базе
        `SELECT code, day, winner, ended_at FROM games ORDER BY ended_at DESC LIMIT ?`,
      )
      .all(limit);
  } catch {
    return [];
  }
}

export function stats(): { rooms: number; games: number } {
  const roomsRow = db.query(`SELECT COUNT(*) AS n FROM rooms`).get() as any;
  const gamesRow = db.query(`SELECT COUNT(*) AS n FROM games`).get() as any;
  return { rooms: roomsRow?.n ?? 0, games: gamesRow?.n ?? 0 };
}

/** Сессия игрока: привязка cookie -> комната/игрок (переживает рестарт). */
export function saveSession(
  sid: string,
  room: string | null,
  player: string | null,
  tab: string | null,
) {
  if (!sid) return;
  try {
    if (!room || !player) {
      deleteSessionStmt.run(sid);
      return;
    }
    upsertSession.run(sid, room, player, tab, Date.now());
  } catch (err) {
    console.error("[store] сессия не сохранена", err);
  }
}

export function loadSessions(): {
  sid: string;
  room: string;
  player: string;
  tab: string | null;
}[] {
  try {
    return selectSessions.all() as any[];
  } catch {
    return [];
  }
}

export function dropSessionsOfRoom(code: string) {
  try {
    deleteSessionsOfRoom.run(code);
  } catch {
    /* нет таблицы — нечего чистить */
  }
}

/** Сбросить отложенные записи (вызывается при остановке процесса). */
export function flush() {
  for (const [, timer] of pendingWrites) clearTimeout(timer);
  pendingWrites.clear();
}

export const dbPath = DB_PATH;

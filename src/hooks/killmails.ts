// killmails.ts (или где твой хук живёт)
import differenceInMilliseconds from 'date-fns/differenceInMilliseconds'
import { useCallback, useEffect, useState } from 'react'
import pickBy from 'lodash/pickBy'
import create from 'zustand'
import parseISO from 'date-fns/parseISO'
import { scaleValue } from '../utils/scaling'
import { useConnection } from './connection'
import uniqueId from 'lodash/uniqueId'

export const normalKillmailAgeMs = 45 * 1000
const trimIntervalMs = 5 * 1000

type RedisQPackage = {
  killmail: {
    killmail_id: number
    killmail_time: string
    solar_system_id: number
    victim: {
      alliance_id?: number
      character_id: number
      corporation_id: number
      ship_type_id: number
      position?: { x: number, y: number, z: number }
    }
  }
  zkb: {
    totalValue: number
    fittedValue: number
    locationID: number
    npc: boolean
    awox: boolean
    solo: boolean
    url: string
  }
}

type Killmail = {
  id: number
  time: Date
  receivedAt: Date
  characterId: number
  corporationId: number
  allianceId?: number
  shipTypeId: number
  solarSystemId: number
  url: string
  totalValue: number
  scaledValue: number
}

type State = {
  killmails: Record<string, Killmail>,
  focused?: Killmail,
  receiveKillmail: (killmail: Killmail) => void,
  trimKillmails: () => void,
  focus: (id: Killmail['id']) => void,
  unfocus: (id: Killmail['id']) => void
}

const shouldKeep = (now: Date, k: Killmail) =>
  differenceInMilliseconds(now, k.receivedAt) < normalKillmailAgeMs * k.scaledValue

const parseKillmail = (raw: RedisQPackage | any): Killmail => {
  // Поддержим и старый формат "плоского" объекта, и redisq.package
  const km = 'killmail' in raw ? raw.killmail : raw
  const zkb = 'zkb' in raw ? raw.zkb : undefined

  const { killmail_id, killmail_time, victim, solar_system_id } = km
  const { character_id, corporation_id, alliance_id, ship_type_id } = victim
  const time = parseISO(killmail_time)

  return {
    id: killmail_id,
    time,
    receivedAt: new Date(),
    characterId: character_id,
    corporationId: corporation_id,
    allianceId: alliance_id,
    shipTypeId: ship_type_id,
    solarSystemId: solar_system_id,
    url: zkb?.url ?? `https://zkillboard.com/kill/${killmail_id}/`,
    totalValue: zkb?.totalValue ?? 0,
    scaledValue: scaleValue(zkb?.totalValue ?? 0),
  }
}

export const useKillmails = create<State>(set => ({
  killmails: {},
  focused: undefined,
  receiveKillmail: (killmail) => { set(s => ({ killmails: { ...s.killmails, [killmail.id]: killmail } })) },
  trimKillmails: () => {
    const keep = shouldKeep.bind(undefined, new Date())
    set(s => {
      const killmails = pickBy(s.killmails, keep)
      const changes: Partial<State> = { killmails }
      if (s.focused && !killmails[s.focused.id]) changes.focused = undefined
      return changes
    })
  },
  focus: (id) => { set(s => ({ focused: s.killmails[id] })) },
  unfocus: (id) => { set(s => s.focused && s.focused.id === id ? { focused: undefined } : {}) }
}))

// ---------- НОВОЕ: Long-poll RedisQ вместо WS ----------
const REDISQ_BASE = 'https://zkillredisq.stream/listen.php'
const QKEY = 'zkbQueueId'
function getQueueId() {
  let q = localStorage.getItem(QKEY)
  if (!q) { q = 'zkbmap-' + Math.random().toString(36).slice(2); localStorage.setItem(QKEY, q) }
  return q
}

// простой long-poll цикл с follow-redirect (fetch делает автоматом)
async function pollRedisQ(onKill: (pkg: RedisQPackage) => void, onTick: () => void, signal: AbortSignal) {
  const queueID = getQueueId()
  while (!signal.aborted) {
    try {
      const url = `${REDISQ_BASE}?queueID=${encodeURIComponent(queueID)}&ttw=10`
      const res = await fetch(url, { redirect: 'follow', cache: 'no-store' })
      if (!res.ok) { await new Promise(r => setTimeout(r, 1000)); continue }
      const data = await res.json() as { package: RedisQPackage | null }
      if (data?.package) onKill(data.package)
      else onTick() // heartbeat, чтобы UI «жил»
    } catch {
      await new Promise(r => setTimeout(r, 1000)) // сеть/429 → пауза
    }
  }
}

export const useKillmailMonitor = (sourceUrl?: string): void => {
  const receivePing = useConnection(useCallback(state => state.receivePing, []))
  const trimKillmails = useKillmails(useCallback(state => state.trimKillmails, []))
  const receiveKillmail = useKillmails(useCallback(state => state.receiveKillmail, []))
  const [nonce] = useState(() => uniqueId('redisq'))

  useEffect(() => {
    const interval = setInterval(trimKillmails, trimIntervalMs)
    return () => clearInterval(interval)
  }, [trimKillmails])

  useEffect(() => {
    const ac = new AbortController()
    pollRedisQ(
      (pkg) => { receiveKillmail(parseKillmail(pkg)); receivePing() },
      () => receivePing(),
      ac.signal
    )
    return () => ac.abort()
  }, [receiveKillmail, receivePing, nonce])
}

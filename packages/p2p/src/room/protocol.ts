// Typed protocol definitions validated through Standard Schema (Zod, Valibot, ArkType, ...).
import type { Reliability } from '../types'
import type { PriorityLevel, SeqLane } from './session'

/** The Standard Schema v1 interface (https://standardschema.dev), inlined to avoid a dependency. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
  }
}

export declare namespace StandardSchemaV1 {
  type Result<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly Issue[] }
  interface Issue {
    readonly message: string
    readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
  }
  type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output']
}

/** Pass-through schema for untyped payloads: `action(any<MyType>())`. */
export function any<T = unknown>(): StandardSchemaV1<T, T> {
  return { '~standard': { version: 1, vendor: 'beamhop', validate: (value) => ({ value: value as T }) } }
}

export type Priority = 'high' | 'normal' | 'low'
export type ReliabilityOption = 'reliable' | 'unordered' | 'unreliable' | Reliability

export interface ActionDef<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly kind: 'action'
  readonly schema: S
  readonly reliability: Reliability
  readonly priority: Priority
}

export interface RequestDef<Q extends StandardSchemaV1 = StandardSchemaV1, R extends StandardSchemaV1 = StandardSchemaV1> {
  readonly kind: 'request'
  readonly req: Q
  readonly res: R
  readonly priority: Priority
  readonly timeoutMs: number
}

export type ProtocolEntry = ActionDef<any> | RequestDef<any, any>
export type ProtocolDef = Record<string, ProtocolEntry>

export function toReliability(r: ReliabilityOption | undefined): Reliability {
  if (!r || r === 'reliable') return { mode: 'reliable' }
  if (r === 'unordered') return { mode: 'unordered' }
  if (r === 'unreliable') return { mode: 'unreliable', maxRetransmits: 0 }
  return r
}

export function action<S extends StandardSchemaV1>(
  schema: S,
  opts: { reliability?: ReliabilityOption; priority?: Priority } = {},
): ActionDef<S> {
  return { kind: 'action', schema, reliability: toReliability(opts.reliability), priority: opts.priority ?? 'normal' }
}

export function request<Q extends StandardSchemaV1, R extends StandardSchemaV1>(
  req: Q,
  res: R,
  opts: { priority?: Priority; timeoutMs?: number } = {},
): RequestDef<Q, R> {
  return { kind: 'request', req, res, priority: opts.priority ?? 'high', timeoutMs: opts.timeoutMs ?? 10_000 }
}

export function defineProtocol<T extends ProtocolDef>(def: T): T {
  for (const name of Object.keys(def)) {
    if (name.startsWith('__')) throw new Error(`protocol: names starting with "__" are reserved (${name})`)
  }
  return def
}

export type ActionNames<P extends ProtocolDef> = { [K in keyof P]: P[K] extends ActionDef<any> ? K : never }[keyof P] & string
export type RequestNames<P extends ProtocolDef> = { [K in keyof P]: P[K] extends RequestDef<any, any> ? K : never }[keyof P] & string

type Out<S> = S extends StandardSchemaV1<any, infer O> ? O : unknown
type In<S> = S extends StandardSchemaV1<infer I, any> ? I : unknown

export type ActionInput<P extends ProtocolDef, K extends keyof P> = P[K] extends ActionDef<infer S> ? In<S> : unknown
export type ActionOutput<P extends ProtocolDef, K extends keyof P> = P[K] extends ActionDef<infer S> ? Out<S> : unknown
export type RequestInput<P extends ProtocolDef, K extends keyof P> = P[K] extends RequestDef<infer Q, any> ? In<Q> : unknown
export type RequestOutput<P extends ProtocolDef, K extends keyof P> = P[K] extends RequestDef<infer Q, any> ? Out<Q> : unknown
export type ResponseInput<P extends ProtocolDef, K extends keyof P> = P[K] extends RequestDef<any, infer R> ? In<R> : unknown
export type ResponseOutput<P extends ProtocolDef, K extends keyof P> = P[K] extends RequestDef<any, infer R> ? Out<R> : unknown

export class ValidationError extends Error {
  constructor(
    readonly issues: readonly StandardSchemaV1.Issue[],
    where: string,
  ) {
    super(`${where}: ${issues.map((i) => i.message).join('; ')}`)
    this.name = 'ValidationError'
  }
}

export async function validate<S extends StandardSchemaV1>(schema: S, value: unknown, where: string): Promise<Out<S>> {
  let r = schema['~standard'].validate(value)
  if (r instanceof Promise) r = await r
  if (r.issues) throw new ValidationError(r.issues, where)
  return r.value as Out<S>
}

export function priorityLevel(p: Priority): PriorityLevel {
  return p === 'high' ? 1 : p === 'low' ? 3 : 2
}

export function laneFor(r: Reliability): SeqLane | 'x' {
  return r.mode === 'reliable' ? 0 : r.mode === 'unordered' ? 1 : 'x'
}

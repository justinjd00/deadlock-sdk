import { DeadlockError } from './errors';
/**
 * Type machinery that turns the generated OpenAPI `paths` into a fully typed
 * request API: the path is autocompleted, path and query parameters are
 * checked, and the JSON response type is inferred.
 */
import type { components, paths } from '../generated/schema';

export type { components, paths };
export type Schemas = components['schemas'];

export type Method = 'get' | 'post' | 'put' | 'delete';

/** Every API path that supports method `M`. */
export type PathsFor<M extends Method> = {
  [P in keyof paths]: paths[P] extends { [K in M]: infer O }
    ? [O] extends [never]
      ? never
      : P
    : never;
}[keyof paths];

export type Operation<P extends keyof paths, M extends Method> = paths[P] extends {
  [K in M]: infer O;
}
  ? O
  : never;

type ParamsOf<O> = O extends { parameters: infer Prm } ? Prm : Record<string, never>;

/** Path parameters of an operation, `never` when it has none. */
export type PathParams<O> = ParamsOf<O> extends { path: infer PP } ? PP : never;

/** Query parameters of an operation, `never` when it has none. */
export type QueryParams<O> =
  ParamsOf<O> extends { query?: infer Q } ? Exclude<Q, undefined> : never;

type HasRequiredQuery<O> = ParamsOf<O> extends { query: object } ? true : false;

type BodyContent<O> = O extends { requestBody?: infer RB }
  ? [NonNullable<RB>] extends [never]
    ? never
    : NonNullable<RB> extends { content: { 'application/json': infer B } }
      ? B
      : never
  : never;

/** JSON request body, `never` when the operation takes none. */
export type RequestBody<O> = [BodyContent<O>] extends [never]
  ? never
  : O extends { requestBody: object }
    ? BodyContent<O>
    : BodyContent<O> | undefined;

type SuccessOf<O> = O extends { responses: infer R }
  ? 200 extends keyof R
    ? R[200]
    : 201 extends keyof R
      ? R[201]
      : never
  : never;

/** The JSON body of the success response. */
export type ResponseData<O> =
  SuccessOf<O> extends { content: { 'application/json': infer J } } ? J : unknown;

/** Languages the asset endpoints support, e.g. `"german"`, `"schinese"`. */
export type Language = NonNullable<QueryParams<Operation<'/v1/assets/heroes', 'get'>>['language']>;

export interface CallOptions {
  signal?: AbortSignal;
  /** Skip the cache for this call (the fresh result is still stored). */
  fresh?: boolean;
  timeout?: number;
}

export type RequestArgs<O> = CallOptions &
  ([PathParams<O>] extends [never] ? { path?: undefined } : { path: PathParams<O> }) &
  ([QueryParams<O>] extends [never]
    ? { query?: undefined }
    : HasRequiredQuery<O> extends true
      ? { query: QueryParams<O> }
      : { query?: QueryParams<O> }) &
  ([RequestBody<O>] extends [never] ? { body?: undefined } : { body: RequestBody<O> });

type NeedsArgs<O> = [PathParams<O>] extends [never]
  ? HasRequiredQuery<O> extends true
    ? true
    : [RequestBody<O>] extends [never]
      ? false
      : undefined extends RequestBody<O>
        ? false
        : true
  : true;

/** Tuple of call arguments: optional when the operation needs no input. */
export type ArgsTuple<O> =
  NeedsArgs<O> extends true ? [args: RequestArgs<O>] : [args?: RequestArgs<O>];

/** Fills `{param}` placeholders, URL-encoding each value. */
export function fillPath(template: string, params?: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      throw new DeadlockError(`Missing path parameter "${name}" for ${template}`, {
        code: 'INVALID_INPUT',
        url: template,
      });
    }
    return encodeURIComponent(String(value));
  });
}

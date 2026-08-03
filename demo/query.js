// Boot flags for the demo pages. Opt-in only: a flag is on when it is spelled
// ?name=1 and off otherwise, so ?dark=0 means what it says.
export function queryFlag(search, name) {
  return new URLSearchParams(search).get(name) === '1';
}

let last = 0

export function nextTimestamp(): number {
  const now = Date.now()
  if (now <= last) {
    last = last + 1
  } else {
    last = now
  }
  return last
}

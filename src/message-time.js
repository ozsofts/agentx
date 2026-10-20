export function formatMessageTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return "时间未知";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const today = new Date(now);
  const yesterday = new Date(now);
  // Compare local calendar days, including month/year and DST boundaries.
  yesterday.setDate(yesterday.getDate() - 1);
  const twoDigits = (value) => String(value).padStart(2, "0");
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  if (date.toDateString() === today.toDateString()) return time;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  const day = `${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
  return `${date.getFullYear() === today.getFullYear() ? "" : `${date.getFullYear()}-`}${day} ${time}`;
}

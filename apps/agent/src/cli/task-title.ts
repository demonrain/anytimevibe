/** Build a stable task label without making another model request. */
export function summarizeTaskTitle(prompt: string, maxLength = 80): string {
  const source = String(prompt ?? "").replace(/\r/g, "");
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line));
  const introduction = /^(?:(?:请|麻烦)?(?:帮我)?(?:完成|实现|处理|检查)?(?:以下|下列|这些|下面)(?:的)?(?:需求|任务|问题|功能)|任务(?:说明)?|需求|背景|(?:please\s+)?(?:help\s+me\s+with\s+)?the\s+following(?:\s+(?:tasks|requirements|issues))?)\s*[:：]?$/i;
  let value = lines.find((line) => !introduction.test(line.replace(/^#{1,6}\s+/, ""))) || lines[0] || source.trim();
  value = value
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)、]\s*/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*\/?(?:task|prompt|request)\s*:\s*/i, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const sentence = value.match(/^(.+?(?:[。！？]|[.!?](?:\s|$)))/);
  if (sentence?.[1]) value = sentence[1].trim();
  if (!value) return "Untitled task";
  const limit = Math.max(1, Math.floor(maxLength));
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  return `${chars.slice(0, Math.max(1, limit - 1)).join("").trimEnd()}…`;
}

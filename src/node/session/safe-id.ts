export function safeSessionFileId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

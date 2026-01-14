import { hash } from "@opencode-ai/util/encode"
import { Platform } from "@/context/platform"

// Web Crypto API helper functions
const CREDENTIALS_STORAGE_KEY = `opencode.server.credentials`
const CREDENTIALS_INDEX_KEY = `opencode.server.credentials.index`

async function getEncryptionKey(): Promise<CryptoKey> {
  // Derive a key from a domain-specific secret (could be improved with user-specific secret)
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("opencode-credentials-v1"),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  )

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("opencode-salt-v1"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

async function encrypt(data: string): Promise<string> {
  const key = await getEncryptionKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(data)

  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded)

  // Combine IV and encrypted data
  const combined = new Uint8Array(iv.length + encrypted.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(encrypted), iv.length)

  // Convert to base64 for storage
  return btoa(String.fromCharCode(...combined))
}

async function decrypt(encryptedData: string): Promise<string> {
  const key = await getEncryptionKey()
  const combined = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0))

  const iv = combined.slice(0, 12)
  const encrypted = combined.slice(12)

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted)

  return new TextDecoder().decode(decrypted)
}

export async function storeServerCredentials(url: string, username: string, password: string) {
  const credentials = JSON.stringify({ username, password })
  const encrypted = await encrypt(credentials)
  const urlHash = await hash(url)

  // Store encrypted credentials
  localStorage.setItem(`${CREDENTIALS_STORAGE_KEY}:${urlHash}`, encrypted)
  console.log("Hashing URL", url)
  console.log("stored credentials", `${CREDENTIALS_STORAGE_KEY}:${urlHash}`, encrypted)

  // Update index
  const index = JSON.parse(localStorage.getItem(CREDENTIALS_INDEX_KEY) || "[]") as string[]
  if (!index.includes(urlHash)) {
    index.push(urlHash)
    localStorage.setItem(CREDENTIALS_INDEX_KEY, JSON.stringify(index))
  }
}

export async function getServerCredentials(url: string) {
  const urlHash = await hash(url)
  console.log("Getting credentials for", urlHash)
  console.log("get credentials", `${CREDENTIALS_STORAGE_KEY}:${urlHash}`)
  const encrypted = localStorage.getItem(`${CREDENTIALS_STORAGE_KEY}:${urlHash}`)
  if (!encrypted) return null

  try {
    const decrypted = await decrypt(encrypted)
    return JSON.parse(decrypted) as { username: string; password: string }
  } catch {
    return null
  }
}

export async function removeServerCredentials(url: string) {
  const urlHash = await hash(url)
  localStorage.removeItem(`${CREDENTIALS_STORAGE_KEY}:${urlHash}`)

  // Update index
  const index = JSON.parse(localStorage.getItem(CREDENTIALS_INDEX_KEY) || "[]") as string[]
  const filtered = index.filter((h) => h !== urlHash)
  localStorage.setItem(CREDENTIALS_INDEX_KEY, JSON.stringify(filtered))
}

export async function listServerCredentials() {
  const index = JSON.parse(localStorage.getItem(CREDENTIALS_INDEX_KEY) || "[]") as string[]
  return index
}

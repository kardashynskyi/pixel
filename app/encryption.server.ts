import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const FORMAT_VERSION = "v1";

function getEncryptionKey(): Buffer {
  const encodedKey = process.env.PIXEL_ENCRYPTION_KEY?.trim();

  if (!encodedKey) {
    throw new Error(
      "PIXEL_ENCRYPTION_KEY environment variable is missing.",
    );
  }

  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      "PIXEL_ENCRYPTION_KEY must be a Base64-encoded 32-byte key.",
    );
  }

  return key;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${FORMAT_VERSION}:`);
}

export function encryptSecret(plainText: string): string {
  const cleanedValue = plainText.trim();

  if (!cleanedValue) {
    throw new Error("Cannot encrypt an empty value.");
  }

  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(cleanedValue, "utf8"),
    cipher.final(),
  ]);

  const authenticationTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    authenticationTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptSecret(encryptedValue: string): string {
  const parts = encryptedValue.split(":");

  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Encrypted value has an invalid format.");
  }

  const [, encodedIv, encodedTag, encodedCipherText] = parts;

  const key = getEncryptionKey();
  const iv = Buffer.from(encodedIv, "base64");
  const authenticationTag = Buffer.from(encodedTag, "base64");
  const cipherText = Buffer.from(encodedCipherText, "base64");

  if (iv.length !== IV_LENGTH) {
    throw new Error("Encrypted value contains an invalid IV.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authenticationTag);

  const decrypted = Buffer.concat([
    decipher.update(cipherText),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
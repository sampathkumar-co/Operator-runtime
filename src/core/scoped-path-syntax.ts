import path from "node:path";
import { OperatorError } from "./errors.ts";

export type ScopedPathSyntax =
  | { kind: "native-absolute"; value: string }
  | { kind: "foreign-windows-absolute"; value: string }
  | { kind: "relative"; value: string };

/**
 * Detect an NTFS alternate data stream suffix without rejecting the drive
 * designator in an ordinary absolute Windows path. ADS names are a separate
 * byte namespace from the file whose path was authorized, so scoped file
 * operations never accept them implicitly.
 */
export function hasWindowsAlternateDataStreamSyntax(
  inputPath: string,
): boolean {
  const normalized = inputPath.replace(/\//g, "\\");
  const extendedDrive = /^\\\\[?.]\\[A-Za-z]:/.test(normalized);
  const ordinaryDrive = /^[A-Za-z]:/.test(normalized);
  const driveColon = extendedDrive ? 5 : ordinaryDrive ? 1 : -1;
  return [...normalized].some(
    (character, index) => character === ":" && index !== driveColon,
  );
}

export function normalizeScopedPathSyntax(inputPath: string): ScopedPathSyntax {
  if (
    process.platform === "win32" &&
    hasWindowsAlternateDataStreamSyntax(inputPath)
  ) {
    throw new OperatorError(
      "WINDOWS_ALTERNATE_DATA_STREAM_DENIED",
      "NTFS alternate data stream paths are outside the authorized file identity.",
    );
  }
  if (path.isAbsolute(inputPath)) {
    return { kind: "native-absolute", value: path.resolve(inputPath) };
  }
  if (process.platform !== "win32" && path.win32.isAbsolute(inputPath)) {
    return { kind: "foreign-windows-absolute", value: inputPath };
  }
  return { kind: "relative", value: inputPath.replace(/\\/g, path.sep) };
}

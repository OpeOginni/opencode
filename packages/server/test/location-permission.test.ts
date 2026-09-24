import { expect, test } from "bun:test"
import { PlatformError } from "effect"
import { isPermissionDenied } from "../src/location"

test("recognizes macOS EPERM even when the platform reason is Unknown", () => {
  expect(
    isPermissionDenied(
      PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "realPath",
        cause: Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
      }),
    ),
  ).toBe(true)
  expect(
    isPermissionDenied(
      PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "realPath" }),
    ),
  ).toBe(false)
})

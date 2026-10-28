import path from "path";

/** Resolve CDN_DIR relative to the project, independently of the process cwd. */
export function getCdnRoot(): string {
    return path.resolve(__dirname, "..", "..", process.env.CDN_DIR || ".cdn");
}

export function getCnCdnRoot(): string {
    return path.join(getCdnRoot(), "cn");
}

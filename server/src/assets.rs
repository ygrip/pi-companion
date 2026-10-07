//! Embedded single-page app.
//!
//! Cache strategy:
//! - `/_app/immutable/**` files are content-hashed by Vite, so they are cached for a year
//!   with `immutable`; a new build produces new file names.
//! - everything else (the SPA shell `200.html`, `_app/version.json`, icons) is served with
//!   `no-cache` plus a strong ETag, so browsers revalidate and get a cheap 304 when nothing
//!   changed, and the new shell immediately after a daemon upgrade.
//! - unknown paths that look like files return 404 instead of the HTML shell, so a stale tab
//!   never receives HTML for a missing script.
//! - client-side routes (`/sessions/abc`, `/devices`, …) fall back to the SPA shell.

use axum::{
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web-dist/"]
struct WebAssets;

const SPA_SHELL: &str = "200.html";
const IMMUTABLE_PREFIX: &str = "_app/immutable/";

/// Same-origin only. Inline scripts are needed for SvelteKit's bootstrap and the
/// pre-paint theme script; inline styles for Svelte transitions and the QR SVG.
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; \
base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

fn looks_like_file(path: &str) -> bool {
    path.rsplit('/').next().is_some_and(|segment| segment.contains('.'))
}

pub async fn serve(uri: Uri, request_headers: HeaderMap) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let name = if requested.is_empty() {
        SPA_SHELL
    } else if WebAssets::get(requested).is_some() {
        requested
    } else if requested.starts_with("_app/") || looks_like_file(requested) {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    } else {
        SPA_SHELL
    };

    let Some(asset) = WebAssets::get(name) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Pi Companion UI is not built. Run `npm run ui:build` and restart the daemon.",
        )
            .into_response();
    };

    let hash = asset.metadata.sha256_hash();
    let etag = format!("\"{}\"", hash.iter().take(16).map(|b| format!("{b:02x}")).collect::<String>());
    let cache = if name.starts_with(IMMUTABLE_PREFIX) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };

    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(value) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, value);
    }
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));

    let not_modified = request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag || tag.trim() == "*"));
    if not_modified {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }

    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let content_type = if mime.type_() == "text" || mime.essence_str() == "application/javascript" {
        format!("{}; charset=utf-8", mime.essence_str())
    } else {
        mime.essence_str().to_string()
    };
    if let Ok(value) = HeaderValue::from_str(&content_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    if name.ends_with(".html") {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
        headers.insert(header::HeaderName::from_static("permissions-policy"), HeaderValue::from_static("camera=(self)"));
        headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    }

    (headers, asset.data.into_owned()).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn pwa_assets_are_served_with_correct_types_and_revalidation() {
        for (path, expected_type) in [
            ("/manifest.webmanifest", "application/manifest+json"),
            ("/icon-192.png", "image/png"),
            ("/icon-512.png", "image/png"),
        ] {
            let response = serve(path.parse().unwrap(), HeaderMap::new()).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], expected_type);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            let mut headers = HeaderMap::new();
            headers.insert(header::IF_NONE_MATCH, response.headers()[header::ETAG].clone());
            assert_eq!(serve(path.parse().unwrap(), headers).await.status(), StatusCode::NOT_MODIFIED);
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            assert!(!bytes.is_empty());
        }
    }

    #[tokio::test]
    async fn nested_routes_include_the_install_manifest() {
        let response = serve("/sessions/example".parse().unwrap(), HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let html = std::str::from_utf8(&bytes).unwrap();
        assert!(html.contains("/manifest.webmanifest"));
        assert!(html.contains("apple-mobile-web-app-capable"));
    }
}

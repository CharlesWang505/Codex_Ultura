pub fn proxied_client(user_agent: &str) -> anyhow::Result<reqwest::Client> {
    let ua = if user_agent.trim().is_empty() {
        format!("Codex_Plus/{}", env!("CARGO_PKG_VERSION"))
    } else {
        user_agent.trim().to_string()
    };
    Ok(reqwest::Client::builder().user_agent(ua).build()?)
}

pub fn vlm_http_client_with_timeout(
    connect_timeout: std::time::Duration,
    request_timeout: std::time::Duration,
) -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(format!("Codex_Compass/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(connect_timeout)
        .timeout(request_timeout)
        .build()?)
}

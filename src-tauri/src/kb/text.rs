/// Keep windows below MiniLM's 256-token limit, even for dense code/Unicode.
/// Overlap preserves facts spanning a boundary without dropping characters.
pub fn chunk(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + 220).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let value = &text[start..end];
        if !value.trim().is_empty() {
            result.push(value.to_string());
        }
        if end == text.len() {
            break;
        }
        start = end.saturating_sub(40);
        while !text.is_char_boundary(start) {
            start += 1;
        }
    }
    result
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm = (a.iter().map(|x| x * x).sum::<f32>() * b.iter().map(|x| x * x).sum::<f32>()).sqrt();
    if norm > 0.0 {
        dot / norm
    } else {
        0.0
    }
}

pub fn fts_query(query: &str) -> String {
    query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .take(32)
        .map(|s| format!("\"{}\"", s))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_windows_keep_tail() {
        let input = "é🦀 ".repeat(1000);
        let chunks = chunk(&input);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.len() <= 220));
        assert!(chunks.last().unwrap().ends_with("é🦀 "));
        assert_eq!(chunk("   "), Vec::<String>::new());
    }
    #[test]
    fn safe_fts_and_cosine() {
        assert_eq!(
            fts_query("C++ OR \"NEAR(*): Kubernetes"),
            "\"C\" OR \"OR\" OR \"NEAR\" OR \"Kubernetes\""
        );
        assert_eq!(cosine(&[1., 0.], &[1., 0.]), 1.);
        assert_eq!(cosine(&[0., 0.], &[1., 0.]), 0.);
        assert_eq!(cosine(&[1.], &[1., 0.]), 0.);
    }
}

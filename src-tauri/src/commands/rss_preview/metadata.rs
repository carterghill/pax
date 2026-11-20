use std::{collections::HashMap, num::NonZeroUsize};

use kuchikiki::{traits::TendrilSink, NodeRef};
use quick_xml::{events::Event, Reader};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticlePreview {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub via: Option<&'static str>,
    pub image: Option<String>,
    pub author_image: Option<String>,
    pub site_image: Option<String>,
    #[serde(skip)]
    publisher_icon: Option<String>,
    pub published_at: Option<String>,
    pub authors: Vec<String>,
}

impl ArticlePreview {
    pub(super) fn with_publisher_icon(mut self) -> Self {
        self.site_image = self.site_image.or(self.publisher_icon.take());
        self
    }

    pub(super) fn fill_from(&mut self, page: Self) {
        if self.authors.is_empty() {
            self.authors = page.authors;
            self.author_image = page.author_image;
        } else if self.author_image.is_none()
            && self.authors.len() == 1
            && page.authors.len() == 1
            && self.authors[0].to_lowercase() == page.authors[0].to_lowercase()
        {
            self.author_image = page.author_image;
        }
        self.title = self.title.take().or(page.title);
        self.description = self.description.take().or(page.description);
        self.site_name = self.site_name.take().or(page.site_name);
        self.image = self.image.take().or(page.image);
        self.site_image = self.site_image.take().or(page.site_image);
        self.published_at = self.published_at.take().or(page.published_at);
    }
}

#[derive(Default)]
pub(super) struct FeedDocument {
    site_name: Option<String>,
    site_image: Option<String>,
    entries: HashMap<String, ArticlePreview>,
}

impl FeedDocument {
    pub(super) fn preview_for(&self, url: &Url) -> Option<ArticlePreview> {
        let mut entry = self.entries.get(&article_key(url))?.clone();
        if entry.site_name.is_none() {
            entry.site_name.clone_from(&self.site_name);
            entry.site_image.clone_from(&self.site_image);
        }
        Some(entry)
    }

    fn add(&mut self, url: &Url, article: ArticlePreview) {
        if self.entries.len() < 500 {
            self.entries.entry(article_key(url)).or_insert(article);
        }
    }
}

fn article_key(url: &Url) -> String {
    let mut url = url.clone();
    url.set_fragment(None);
    let google_news_article =
        super::is_google_news(&url) && url.path().starts_with("/rss/articles/");
    let tracking_parameter =
        |key: &str| key.starts_with("utm_") || (google_news_article && key == "oc");
    if url.query_pairs().any(|(key, _)| tracking_parameter(&key)) {
        let pairs = url
            .query_pairs()
            .filter(|(key, _)| !tracking_parameter(key))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        url.set_query(None);
        if !pairs.is_empty() {
            url.query_pairs_mut().extend_pairs(pairs);
        }
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    url.into()
}

fn web_url(base: &Url, raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with('#') {
        return None;
    }
    let mut url = base.join(raw).ok()?;
    url.set_fragment(None);
    super::public_web_url(&url).then_some(url)
}

fn image_url(base: &Url, raw: Option<&str>) -> Option<String> {
    web_url(base, raw?).map(Into::into)
}

fn plain(raw: &str, max: usize) -> Option<String> {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    if let Some((end, _)) = text.char_indices().nth(max) {
        Some(format!("{}…", text[..end].trim_end()))
    } else {
        Some(text)
    }
}

fn feed_text(raw: &str, max: usize) -> Option<String> {
    if !raw.contains('<') && !raw.contains('&') {
        return plain(raw, max);
    }
    let doc = kuchikiki::parse_html().one(raw).document_node;
    if let Ok(nodes) = doc.select("script, style, noscript, template, head") {
        for node in nodes {
            node.as_node().detach();
        }
    }
    let mut text = String::new();
    for node in doc.descendants() {
        if let Some(element) = node.as_element() {
            if matches!(element.name.local.as_ref(), "p" | "div" | "br" | "li") {
                text.push(' ');
            }
        }
        if let Some(value) = node.as_text() {
            text.push_str(&value.borrow());
        }
    }
    plain(&text, max)
}

fn author_name(raw: &str) -> Option<String> {
    let name = plain(raw, 120)?;
    if !name.contains('@') {
        return Some(name);
    }
    // Older RSS feeds often use "email (display name)" in the author element.
    let (_, label) = name.split_once('(')?;
    let label = label.strip_suffix(')')?;
    (!label.contains('@')).then(|| plain(label, 120)).flatten()
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct XmlFeed {
    channel: Option<Box<XmlFeed>>,
    title: String,
    image: Option<XmlLogo>,
    logo: String,
    icon: String,
    author: Vec<XmlAuthor>,
    item: Vec<XmlEntry>,
    entry: Vec<XmlEntry>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct XmlLogo {
    url: String,
    #[serde(rename = "@resource")]
    resource: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct XmlAuthor {
    name: String,
    #[serde(rename = "$text")]
    text: String,
}

impl XmlAuthor {
    fn name(&self) -> Option<String> {
        author_name(&self.name).or_else(|| author_name(&self.text))
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct XmlLink {
    #[serde(rename = "@href")]
    href: String,
    #[serde(rename = "@rel")]
    rel: String,
    #[serde(rename = "@type")]
    mime: String,
    #[serde(rename = "$text")]
    text: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct XmlImage {
    #[serde(rename = "@url")]
    url: String,
    #[serde(rename = "@medium")]
    medium: String,
    #[serde(rename = "@type")]
    mime: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct XmlImages {
    thumbnail: Vec<XmlImage>,
    content: Vec<XmlImage>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct XmlSource {
    #[serde(rename = "@url")]
    url: String,
    #[serde(rename = "$text")]
    text: String,
    title: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct XmlEntry {
    title: String,
    description: String,
    summary: String,
    encoded: String,
    link: Vec<XmlLink>,
    creator: Vec<String>,
    author: Vec<XmlAuthor>,
    source: Vec<XmlSource>,
    #[serde(rename = "pubDate")]
    pub_date: String,
    published: String,
    date: String,
    thumbnail: Vec<XmlImage>,
    content: Vec<XmlImage>,
    enclosure: Vec<XmlImage>,
    group: Vec<XmlImages>,
}

fn parse_xml_feed(raw: &str, base: &Url) -> Option<FeedDocument> {
    let mut reader = Reader::from_str(raw);
    let mut depth = 0_usize;
    loop {
        match reader.read_event().ok()? {
            Event::Start(tag) => {
                if depth == 0 && !matches!(tag.local_name().as_ref(), b"rss" | b"feed" | b"RDF") {
                    return None;
                }
                depth += 1;
                if depth > 32 {
                    return None;
                }
            }
            Event::End(_) => depth = depth.checked_sub(1)?,
            Event::Eof => break,
            _ => {}
        }
    }
    let mut deserializer = quick_xml::de::Deserializer::from_str(raw);
    deserializer.event_buffer_size(NonZeroUsize::new(100_000));
    let mut root = XmlFeed::deserialize(&mut deserializer).ok()?;
    let channel = root.channel.take();
    let source = channel.as_deref().unwrap_or(&root);
    let via_google_news = super::is_google_news(base).then_some("Google News");
    let mut feed = FeedDocument {
        site_name: feed_text(&source.title, 120),
        site_image: source
            .image
            .as_ref()
            .and_then(|logo| {
                image_url(base, Some(&logo.url)).or_else(|| image_url(base, Some(&logo.resource)))
            })
            .or_else(|| image_url(base, Some(&source.logo)))
            .or_else(|| image_url(base, Some(&source.icon))),
        ..Default::default()
    };
    for entry in root.item.iter().chain(&root.entry).chain(
        channel
            .iter()
            .flat_map(|channel| channel.item.iter().chain(&channel.entry)),
    ) {
        let Some(url) = entry.link.iter().find_map(|link| {
            if link.rel.is_empty() || link.rel == "alternate" {
                web_url(base, &link.href).or_else(|| web_url(base, &link.text))
            } else {
                None
            }
        }) else {
            continue;
        };
        let (site_name, publisher_url) = entry
            .source
            .iter()
            .find_map(|source| {
                let publisher_url = web_url(base, &source.url);
                let name = feed_text(&source.title, 120).or_else(|| {
                    publisher_url.as_ref()?;
                    feed_text(&source.text, 120)
                })?;
                Some((Some(name), publisher_url))
            })
            .unwrap_or_default();
        let via = site_name.as_ref().and(via_google_news);
        let publisher_icon = via
            .and(publisher_url.as_ref())
            .and_then(|url| image_url(url, Some("/favicon.ico")));
        let title = site_name
            .as_deref()
            .filter(|_| via.is_some())
            .and_then(|publisher| entry.title.strip_suffix(&format!(" - {publisher}")))
            .unwrap_or(&entry.title);
        let mut authors = entry
            .creator
            .iter()
            .filter_map(|name| author_name(name))
            .collect::<Vec<_>>();
        if authors.is_empty() {
            authors.extend(entry.author.iter().filter_map(XmlAuthor::name));
        }
        if authors.is_empty() {
            authors.extend(source.author.iter().filter_map(XmlAuthor::name));
        }
        authors.truncate(8);
        let image = entry
            .thumbnail
            .iter()
            .chain(entry.group.iter().flat_map(|group| &group.thumbnail))
            .chain(
                entry
                    .content
                    .iter()
                    .chain(&entry.enclosure)
                    .chain(entry.group.iter().flat_map(|group| &group.content))
                    .filter(|image| image.medium == "image" || image.mime.starts_with("image/")),
            )
            .find_map(|image| image_url(base, Some(&image.url)))
            .or_else(|| {
                entry
                    .link
                    .iter()
                    .filter(|link| link.rel == "enclosure" && link.mime.starts_with("image/"))
                    .find_map(|link| image_url(base, Some(&link.href)))
            });
        feed.add(
            &url,
            ArticlePreview {
                title: feed_text(title, 240),
                description: [&entry.description, &entry.summary, &entry.encoded]
                    .into_iter()
                    .find_map(|raw| feed_text(raw, 360)),
                site_name,
                via,
                image,
                publisher_icon,
                published_at: [&entry.pub_date, &entry.published, &entry.date]
                    .into_iter()
                    .find_map(|raw| plain(raw, 80)),
                authors,
                ..Default::default()
            },
        );
    }
    (!feed.entries.is_empty()).then_some(feed)
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        Some(value) if !value.is_null() => std::slice::from_ref(value),
        _ => &[],
    }
}

fn named_authors<'a>(
    raw: &'a [Value],
    resolve: impl Fn(&'a Value) -> &'a Value,
) -> Vec<(String, &'a Value)> {
    raw.iter()
        .filter_map(|item| {
            let item = resolve(item);
            let name = string_at(item, "name").or_else(|| item.as_str())?;
            Some((author_name(name)?, item))
        })
        .take(8)
        .collect()
}

fn json_feed(raw: &str, base: &Url) -> Option<FeedDocument> {
    let root: Value = serde_json::from_str(raw).ok()?;
    if !string_at(&root, "version")?.starts_with("https://jsonfeed.org/version/") {
        return None;
    }
    let mut feed = FeedDocument {
        site_name: string_at(&root, "title").and_then(|raw| plain(raw, 120)),
        site_image: image_url(base, string_at(&root, "favicon"))
            .or_else(|| image_url(base, string_at(&root, "icon"))),
        ..Default::default()
    };
    for item in list(root.get("items")).iter().take(500) {
        let author_values = item
            .get("authors")
            .or_else(|| item.get("author"))
            .or_else(|| root.get("authors"))
            .or_else(|| root.get("author"));
        let authors = named_authors(list(author_values), |item| item);
        let author_image = if let [(.., author)] = authors.as_slice() {
            image_url(base, string_at(author, "avatar"))
        } else {
            None
        };
        let article = ArticlePreview {
            title: string_at(item, "title").and_then(|raw| plain(raw, 240)),
            description: string_at(item, "summary")
                .or_else(|| string_at(item, "content_text"))
                .and_then(|raw| plain(raw, 360)),
            image: image_url(
                base,
                string_at(item, "image").or_else(|| string_at(item, "banner_image")),
            ),
            published_at: string_at(item, "date_published").and_then(|raw| plain(raw, 80)),
            authors: authors.into_iter().map(|(name, _)| name).collect(),
            author_image,
            ..Default::default()
        };
        for field in ["external_url", "url"] {
            if let Some(url) = string_at(item, field).and_then(|raw| web_url(base, raw)) {
                feed.add(&url, article.clone());
            }
        }
    }
    Some(feed)
}

pub(super) fn parse_feed(raw: &str, base: &Url) -> Option<FeedDocument> {
    let raw = raw.trim_start_matches('\u{feff}').trim_start();
    if raw.starts_with('{') {
        json_feed(raw, base)
    } else {
        parse_xml_feed(raw, base)
    }
}

fn schema_image(value: &Value) -> Option<&str> {
    list(Some(value)).iter().find_map(|item| {
        item.as_str()
            .or_else(|| string_at(item, "url"))
            .or_else(|| string_at(item, "contentUrl"))
    })
}

fn schema_objects(value: &Value) -> impl Iterator<Item = &Value> {
    list(Some(value))
        .iter()
        .flat_map(|item| std::iter::once(item).chain(list(item.get("@graph"))))
}

fn article_type(value: &Value) -> bool {
    list(value.get("@type"))
        .iter()
        .filter_map(Value::as_str)
        .any(|kind| {
            let kind = kind.rsplit(['/', ':']).next().unwrap_or(kind);
            kind.ends_with("Article") || matches!(kind, "BlogPosting" | "LiveBlogPosting")
        })
}

fn portrait(doc: &NodeRef, name: &str, base: &Url) -> Option<String> {
    let photo_label = format!("photo of {}", name.to_lowercase());
    doc.select("img[alt]").ok()?.find_map(|image| {
        let attrs = image.attributes.borrow();
        (attrs.get("alt")?.trim().to_lowercase() == photo_label).then_some(())?;
        image_url(base, attrs.get("data-src").or_else(|| attrs.get("src")))
    })
}

pub(super) fn parse_article(html: &str, base: &Url, feed_author: Option<&str>) -> ArticlePreview {
    let doc = kuchikiki::parse_html().one(html).document_node;
    let mut meta = HashMap::new();
    if let Ok(nodes) = doc.select("head meta") {
        for node in nodes {
            let attrs = node.attributes.borrow();
            if let (Some(key), Some(content)) = (
                attrs.get("property").or_else(|| attrs.get("name")),
                attrs.get("content"),
            ) {
                meta.entry(key.to_ascii_lowercase())
                    .or_insert_with(|| content.to_owned());
            }
        }
    }
    let meta_value = |key| meta.get(key).map(String::as_str);
    let schema = doc
        .select("script[type=\"application/ld+json\"]")
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|node| serde_json::from_str::<Value>(&node.text_contents()).ok())
        .collect::<Vec<_>>();
    let objects = schema.iter().flat_map(schema_objects).collect::<Vec<_>>();
    let article = objects.iter().copied().find(|object| article_type(object));
    let resolve = |item| {
        string_at(item, "@id")
            .and_then(|id| {
                objects.iter().copied().find(|object| {
                    string_at(object, "@id") == Some(id)
                        && (object.get("name").is_some() || object.get("image").is_some())
                })
            })
            .unwrap_or(item)
    };
    let field = |key| article.and_then(|article| string_at(article, key));
    let publisher = article
        .and_then(|article| article.get("publisher"))
        .map(resolve);
    let mut authors = named_authors(
        list(article.and_then(|article| article.get("author"))),
        resolve,
    );
    let empty = Value::Null;
    if authors.is_empty() {
        if let Some(name) = meta_value("author")
            .or_else(|| meta_value("byl"))
            .or_else(|| meta_value("article:author"))
            .filter(|value| !value.contains("://") && !value.starts_with('/'))
            .and_then(author_name)
            .or_else(|| feed_author.map(str::to_owned))
        {
            authors.push((name, &empty));
        }
    }
    let author_image = if let [(name, data)] = authors.as_slice() {
        image_url(base, data.get("image").and_then(schema_image))
            .or_else(|| portrait(&doc, name, base))
    } else {
        None
    };
    let site_icon = || {
        doc.select("head link[rel]").ok()?.find_map(|link| {
            let attrs = link.attributes.borrow();
            attrs
                .get("rel")?
                .split_ascii_whitespace()
                .any(|rel| rel == "icon" || rel == "apple-touch-icon")
                .then_some(())?;
            image_url(base, attrs.get("href"))
        })
    };
    ArticlePreview {
        title: meta_value("og:title")
            .or_else(|| field("headline"))
            .or_else(|| meta_value("twitter:title"))
            .and_then(|raw| plain(raw, 240))
            .or_else(|| {
                doc.select_first("head title")
                    .ok()
                    .and_then(|node| plain(&node.text_contents(), 240))
            }),
        description: meta_value("og:description")
            .or_else(|| field("description"))
            .or_else(|| meta_value("description"))
            .or_else(|| meta_value("twitter:description"))
            .and_then(|raw| plain(raw, 360)),
        site_name: meta_value("og:site_name")
            .or_else(|| publisher.and_then(|data| string_at(data, "name")))
            .and_then(|raw| plain(raw, 120)),
        via: None,
        image: image_url(base, meta_value("og:image"))
            .or_else(|| {
                image_url(
                    base,
                    article
                        .and_then(|data| data.get("image"))
                        .and_then(schema_image),
                )
            })
            .or_else(|| image_url(base, meta_value("twitter:image"))),
        site_image: image_url(
            base,
            publisher
                .and_then(|data| data.get("logo"))
                .and_then(schema_image),
        )
        .or_else(site_icon),
        publisher_icon: None,
        published_at: meta_value("article:published_time")
            .or_else(|| field("datePublished"))
            .and_then(|raw| plain(raw, 80)),
        authors: authors.into_iter().map(|(name, _)| name).collect(),
        author_image,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rss_namespaced_metadata_and_matches_tracking_links() {
        let base = Url::parse("https://example.com/feed").unwrap();
        let feed = parse_feed(
            r#"<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
            <channel><title>Tech News</title><image><url>/logo.png</url></image>
            <item><title>A &amp; B</title><link>https://example.com/story/</link>
            <description><![CDATA[<p>Short <em>summary</em>.</p>]]></description>
            <dc:creator>Ashley Belanger</dc:creator><pubDate>Wed, 18 Nov 2026 16:00:00 GMT</pubDate>
            <media:content medium="image" url="/story.jpg" />
            <media:thumbnail url="/thumb.jpg" />
            </item></channel></rss>"#,
            &base,
        ).unwrap();
        let link = Url::parse("https://example.com/story?utm_source=rss#read").unwrap();
        let preview = feed.preview_for(&link).unwrap();
        assert_eq!(preview.title.as_deref(), Some("A & B"));
        assert_eq!(preview.authors, ["Ashley Belanger"]);
        assert_eq!(preview.site_name.as_deref(), Some("Tech News"));
        assert_eq!(
            preview.site_image.as_deref(),
            Some("https://example.com/logo.png")
        );
        assert_eq!(
            preview.image.as_deref(),
            Some("https://example.com/thumb.jpg")
        );
        assert_eq!(preview.description.as_deref(), Some("Short summary."));
    }

    #[test]
    fn google_news_credits_the_item_publisher_when_provided() {
        let base = Url::parse("https://news.google.com/rss/search?q=reuters").unwrap();
        let feed = parse_feed(
            r#"<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Reuters - Google News</title>
            <image><url>https://news.google.com/logo.png</url></image>
            <item><title>A headline - Reuters</title><link>https://news.google.com/rss/articles/abc?oc=5</link>
            <media:thumbnail url="https://www.reuters.com/images/story.jpg"/>
            <source url="https://www.reuters.com">Reuters</source></item>
            <item><title>Another headline</title><link>https://news.google.com/rss/articles/def</link></item>
            </channel></rss>"#,
            &base,
        )
        .unwrap();

        let link = base.join("/rss/articles/abc").unwrap();
        let preview = feed.preview_for(&link).unwrap();
        assert_eq!(preview.title.as_deref(), Some("A headline"));
        assert_eq!(preview.site_name.as_deref(), Some("Reuters"));
        assert_eq!(preview.via, Some("Google News"));
        assert_eq!(
            preview.image.as_deref(),
            Some("https://www.reuters.com/images/story.jpg")
        );
        assert_eq!(
            preview.with_publisher_icon().site_image.as_deref(),
            Some("https://www.reuters.com/favicon.ico")
        );
        assert!(feed
            .preview_for(&Url::parse("https://www.reuters.com").unwrap())
            .is_none());

        let unattributed = feed
            .preview_for(&base.join("/rss/articles/def").unwrap())
            .unwrap();
        assert_eq!(
            unattributed.site_name.as_deref(),
            Some("Reuters - Google News")
        );
        assert!(unattributed.via.is_none());
    }

    #[test]
    fn reads_atom_links_and_json_feed_avatars() {
        let base = Url::parse("https://example.com/feed").unwrap();
        let article = base.join("/story").unwrap();
        let atom = parse_feed(
            r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Tech</title>
            <entry><title>Story</title><author><name>Reporter</name></author>
            <link href="/feed" rel="self"/><link rel="alternate" href="/story"/>
            <link rel="enclosure" type="image/png" href="/story.png"/>
            </entry></feed>"#,
            &base,
        )
        .unwrap();
        let preview = atom.preview_for(&article).unwrap();
        assert_eq!(preview.authors, ["Reporter"]);
        assert_eq!(
            preview.image.as_deref(),
            Some("https://example.com/story.png")
        );

        let json = parse_feed(r#"{"version":"https://jsonfeed.org/version/1.1","title":"Tech",
            "items":[{"url":"https://example.com/story","authors":[{"name":"Reporter","avatar":"/me.png"}]}]}"#,
            &base).unwrap();
        assert_eq!(
            json.preview_for(&article).unwrap().author_image.as_deref(),
            Some("https://example.com/me.png")
        );
    }

    #[test]
    fn fills_gaps_and_attaches_a_portrait_only_to_the_matching_feed_author() {
        let base = Url::parse("https://example.com/story").unwrap();
        let page = parse_article(
            r##"<html><head>
            <meta property="og:title" content="Page headline"><meta property="og:image" content="/story.png">
            <script type="application/ld+json">{"@graph":[
              {"@type":"NewsArticle","author":{"@id":"#reporter"},"publisher":{"name":"Tech News","logo":{"url":"/logo.png"}}},
              {"@type":"Person","@id":"#reporter","name":"Ashley Belanger"}]}</script></head>
            <body><img src="/no.png" alt="Other reporter"><img src="/ashley.jpg" alt="Photo of Ashley Belanger"></body></html>"##,
            &base,
            None,
        );
        let mut entry = ArticlePreview {
            title: Some("Feed headline".into()),
            authors: vec!["Ashley Belanger".into()],
            ..Default::default()
        };
        entry.fill_from(page.clone());
        assert_eq!(entry.title.as_deref(), Some("Feed headline"));
        assert_eq!(entry.site_name.as_deref(), Some("Tech News"));
        assert_eq!(
            entry.image.as_deref(),
            Some("https://example.com/story.png")
        );
        assert_eq!(
            entry.author_image.as_deref(),
            Some("https://example.com/ashley.jpg")
        );
        let mut alternate = ArticlePreview {
            authors: vec!["Someone Else".into()],
            ..Default::default()
        };
        alternate.fill_from(page);
        assert!(alternate.author_image.is_none());

        let without_page_byline = parse_article(
            r#"<img src="/ashley.jpg" alt="Photo of Ashley Belanger">"#,
            &base,
            Some("Ashley Belanger"),
        );
        assert_eq!(
            without_page_byline.author_image.as_deref(),
            Some("https://example.com/ashley.jpg")
        );
    }
}

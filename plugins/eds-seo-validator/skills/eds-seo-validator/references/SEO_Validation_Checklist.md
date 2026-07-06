# SEO Validation Checklist

A generic, reusable checklist covering all major SEO validation areas applicable to any website.

---

## 1. Metadata

- [ ] Meta title present on every page
- [ ] Meta title unique per page (no duplicates including paginated)
- [ ] Meta title length 50–60 characters
- [ ] Meta title contains primary target keyword
- [ ] Meta description present on every page
- [ ] Meta description unique per page
- [ ] Meta description length 140–160 characters
- [ ] Meta description contains target keyword and a clear CTA
- [ ] Meta keywords tag removed (obsolete, adds no value)
- [ ] Robots meta tag: `index, follow` on live; `noindex, nofollow` on staging/UAT

---

## 2. JSON-LD / Structured Data

- [ ] WebSite + Sitelink Searchbox schema on all pages
- [ ] Organization schema on homepage, About Us, and Contact pages
- [ ] BreadcrumbList schema on all pages except homepage
- [ ] FAQPage schema on every page containing an FAQ section
- [ ] ItemList schema on all category/listing pages
- [ ] Product schema on all product detail pages
- [ ] PriceSpecification schema where products are listed with prices
- [ ] VideoObject schema on all pages containing video content
- [ ] All schemas validated with Google Rich Results Test (no errors)
- [ ] Schema placed in `<head>` section as `application/ld+json`

---

## 3. Heading Structure

- [ ] Exactly one H1 per page — represents the primary topic
- [ ] H1 is unique across all pages (no duplicates)
- [ ] Heading hierarchy is sequential — no skipped levels (H1 → H2 → H3)
- [ ] H2s used for main section headings; H3–H6 for sub-sections
- [ ] Headings contain relevant target keywords where natural

---

## 4. Canonical & Duplicate Prevention

- [ ] `rel=canonical` present on every indexable page
- [ ] Canonical tags correct on paginated pages
- [ ] Canonical tags on all parameterised URLs (filters, sorting, tracking)
- [ ] Only one version of each URL: www vs non-www (301 redirect in place)
- [ ] HTTP → HTTPS 301 redirect in place; HTTPS-only access enforced
- [ ] Trailing-slash vs non-trailing-slash URLs resolved (no duplicates)

---

## 5. Crawlability & Indexing

- [ ] `robots.txt` present, correctly configured, no key pages blocked
- [ ] XML sitemap present and referenced in `robots.txt`
- [ ] XML sitemap submitted to Google Search Console
- [ ] HTML sitemap present, dynamic, and reflects site architecture
- [ ] No test/staging pages indexed in Google
- [ ] Googlebot not treated differently from other bots in `robots.txt`
- [ ] GSC parameter handling configured for indexable URL parameters
- [ ] Crawl depth ≤ 4 clicks from homepage for all content
- [ ] Crawl budget not wasted on faceted navigation, soft errors, or low-quality pages
- [ ] No orphaned pages (every page has at least one internal link)

---

## 6. URL Structure

- [ ] All URLs lowercase (no uppercase characters)
- [ ] Hyphens used as word separators (not underscores)
- [ ] URLs descriptive, keyword-rich, and aligned to site information architecture
- [ ] No legacy URLs present in internal links
- [ ] Internal links use static URLs (not JS hash `#` links)

---

## 7. Internal Links & Navigation

- [ ] All internal links return HTTP 200 status
- [ ] All internal links point to indexable, self-canonicalised HTTPS URLs
- [ ] Anchor text is descriptive and unique (no generic "click here")
- [ ] Alt text used as anchor for image links
- [ ] Navigation works without JavaScript (static clickable elements)
- [ ] Breadcrumb navigation on all pages except homepage
- [ ] FAQ pages link to relevant internal content

---

## 8. Redirects & Errors

- [ ] No 404 status URLs — all dead URLs 301 redirected to relevant pages
- [ ] Server-side 301 used (not 302 temporary) for retired URLs
- [ ] No redirect chains longer than one hop
- [ ] Custom 404 page with logo, navigation, and helpful message

---

## 9. Social & OG Tags

- [ ] `og:title` present on all pages
- [ ] `og:description` present on all pages
- [ ] `og:image` present (1200×630px recommended)
- [ ] `og:url`, `og:type`, `og:site_name` present on all pages
- [ ] `twitter:title`, `twitter:description`, `twitter:image` present
- [ ] `twitter:site` set to verified Twitter/X handle

---

## 10. Core Web Vitals & Performance

- [ ] LCP (Largest Contentful Paint) ≤ 2.5 s
- [ ] FCP (First Contentful Paint) ≤ 1.8 s
- [ ] INP (Interaction to Next Paint) ≤ 200 ms
- [ ] CLS (Cumulative Layout Shift) ≤ 0.1
- [ ] TTFB (Time to First Byte) ≤ 800 ms
- [ ] All pages served over HTTPS / HTTP2

---

## 11. Images & Accessibility

- [ ] All images have descriptive, keyword-informed alt text
- [ ] Decorative images use empty alt (`alt=""`)
- [ ] All buttons have accessible labels (not just an icon)
- [ ] Favicon present
- [ ] No notification permission prompts on page load
- [ ] Password fields allow paste

---

## 12. Mobile & Responsive

- [ ] Responsive design for desktop, tablet, and mobile
- [ ] Viewport meta tag set correctly (no fixed-width viewport)
- [ ] Mobile renders same content on first load as desktop
- [ ] No horizontal scrolling required on mobile
- [ ] Touch targets not too close together (≥ 48px spacing)
- [ ] No content hidden via `display:none` / `visibility:hidden` from Googlebot

---

## 13. Pagination & JS Content

- [ ] `rel=next` / `rel=prev` present on paginated pages
- [ ] Infinite scroll does not block content from crawlers
- [ ] JavaScript-loaded content accessible to Googlebot
- [ ] User-generated dynamic pages not indexed unintentionally

---

*Total checks: 80*

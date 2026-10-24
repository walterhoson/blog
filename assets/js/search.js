const form = document.querySelector("#blog-search-form");
const input = document.querySelector("#blog-search-input");
const results = document.querySelector("#blog-search-results");
const status = document.querySelector("#blog-search-status");
const script = document.querySelector("#blog-search-script");

if (form && input && results && status && script) {
  const basePath = script.dataset.pagefindBase || "/pagefind/";
  let pagefindPromise;
  let debounceTimer;
  let searchSequence = 0;

  const loadPagefind = () => {
    if (!pagefindPromise) {
      pagefindPromise = import(`${basePath}pagefind.js`)
        .then(async (pagefind) => {
          const instance = pagefind.createInstance({ basePath, language: "zh" });
          await instance.init();
          return instance;
        })
        .catch((error) => {
          pagefindPromise = undefined;
          throw error;
        });
    }
    return pagefindPromise;
  };

  const normalize = (value) =>
    value
      .toLocaleLowerCase("zh-CN")
      .replace(/[\s\p{P}\p{S}]+/gu, "");

  const segmentWords = (value) => {
    if (typeof Intl.Segmenter === "undefined") {
      return value.trim().split(/\s+/).filter(Boolean);
    }

    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    return Array.from(segmenter.segment(value))
      .filter((item) => item.isWordLike)
      .map((item) => item.segment.trim())
      .filter(Boolean);
  };

  const exactQuery = (value) => {
    const words = segmentWords(value);
    return words.length > 1 ? `"${words.join(" ")}"` : null;
  };

  const titleBoost = (title, query, words) => {
    const normalizedTitle = normalize(title);
    const normalizedQuery = normalize(query);

    if (normalizedTitle === normalizedQuery) return 100000;
    if (normalizedTitle.includes(normalizedQuery)) return 70000;
    if (words.length > 1 && words.every((word) => normalizedTitle.includes(normalize(word)))) {
      return 50000;
    }
    return 0;
  };

  const createResult = ({ data }) => {
    const article = document.createElement("article");
    article.className = "blog-search-result";

    const heading = document.createElement("h2");
    const link = document.createElement("a");
    link.href = data.url;
    link.textContent = data.meta?.title || "Untitled";
    heading.appendChild(link);
    article.appendChild(heading);

    const excerpt = document.createElement("p");
    excerpt.innerHTML = data.excerpt;
    article.appendChild(excerpt);

    const sections = (data.sub_results || [])
      .filter((item) => item.url !== data.url)
      .slice(0, 2);
    if (sections.length) {
      const sectionList = document.createElement("div");
      sectionList.className = "blog-search-result__sections";
      for (const section of sections) {
        const sectionLink = document.createElement("a");
        sectionLink.href = section.url;
        sectionLink.textContent = `# ${section.title}`;
        sectionList.appendChild(sectionLink);
      }
      article.appendChild(sectionList);
    }

    return article;
  };

  const renderEmpty = (query) => {
    results.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "blog-search-empty";
    empty.textContent = `No results for “${query}”. Try a shorter query.`;
    results.appendChild(empty);
  };

  const runSearch = async (query) => {
    const currentSequence = ++searchSequence;
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      status.textContent = "";
      results.replaceChildren();
      return;
    }

    status.textContent = "Searching…";
    results.replaceChildren();

    try {
      const pagefind = await loadPagefind();
      const phrase = exactQuery(trimmedQuery);
      const [broadResult, exactResult] = await Promise.all([
        pagefind.search(trimmedQuery),
        phrase ? pagefind.search(phrase) : Promise.resolve({ results: [] }),
      ]);

      if (currentSequence !== searchSequence) return;

      const exactIds = new Set(exactResult.results.map((item) => item.id));
      const candidates = new Map();
      for (const item of exactResult.results) candidates.set(item.id, item);
      for (const item of broadResult.results.slice(0, 40)) {
        if (!candidates.has(item.id)) candidates.set(item.id, item);
      }

      const words = segmentWords(trimmedQuery);
      const loaded = (
        await Promise.all(
          Array.from(candidates.values()).map(async (item) => {
            try {
              return { item, data: await item.data() };
            } catch {
              return null;
            }
          }),
        )
      ).filter(Boolean);

      if (currentSequence !== searchSequence) return;

      loaded.sort((left, right) => {
        const leftScore =
          titleBoost(left.data.meta?.title || "", trimmedQuery, words) +
          (exactIds.has(left.item.id) ? 10000 : 0) +
          left.item.score;
        const rightScore =
          titleBoost(right.data.meta?.title || "", trimmedQuery, words) +
          (exactIds.has(right.item.id) ? 10000 : 0) +
          right.item.score;
        return rightScore - leftScore;
      });

      if (!loaded.length) {
        status.textContent = "";
        renderEmpty(trimmedQuery);
        return;
      }

      const total = broadResult.unfilteredResultCount || loaded.length;
      status.textContent = `${total} ${total === 1 ? "result" : "results"}`;
      results.replaceChildren(...loaded.slice(0, 20).map(createResult));
    } catch (error) {
      if (currentSequence !== searchSequence) return;
      status.textContent = "Search is temporarily unavailable. Please try again.";
      results.replaceChildren();
      console.error("Failed to search the blog", error);
    }
  };

  const updateUrl = (query) => {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    window.history.replaceState({}, "", url);
  };

  input.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    searchSequence += 1;
    updateUrl(input.value);
    debounceTimer = window.setTimeout(() => runSearch(input.value), 180);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    window.clearTimeout(debounceTimer);
    updateUrl(input.value);
    runSearch(input.value);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== input) {
      event.preventDefault();
      input.focus();
    }
    if (event.key === "Escape" && document.activeElement === input) {
      input.value = "";
      updateUrl("");
      runSearch("");
      input.blur();
    }
  });

  const initialQuery = new URL(window.location.href).searchParams.get("q") || "";
  if (initialQuery) {
    input.value = initialQuery;
    runSearch(initialQuery);
  }
}

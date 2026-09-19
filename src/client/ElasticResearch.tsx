import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  Database,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import type {
  ElasticAnswer,
  ElasticComment,
  ElasticProductsResponse,
  ElasticQueryInput,
  ElasticScope,
} from "../shared/contracts";
import { safeEvidenceUrl } from "./voice";

const fullScope = (): ElasticScope => ({
  excludedVideoIds: [],
  from: null,
  to: null,
});

function AnswerText({
  text,
  sourceCount,
  onCitation,
}: {
  text: string;
  sourceCount: number;
  onCitation: (source: number) => void;
}) {
  // Render a small, safe subset of Markdown. Provider text never becomes HTML.
  return text.split(/\n\s*\n/).map((block, index) => (
    <p key={index}>
      {block
        .replace(/^#{1,6}\s+/gm, "")
        .split(/(\*\*[^*]+\*\*|\[\d+\])/g)
        .map((part, partIndex) => {
          if (part.startsWith("**") && part.endsWith("**"))
            return <strong key={partIndex}>{part.slice(2, -2)}</strong>;
          const source = /^\[\d+\]$/.test(part) ? Number(part.slice(1, -1)) : 0;
          if (source > 0 && source <= sourceCount)
            return (
              <a
                key={partIndex}
                className="elastic-citation"
                href={`#elastic-source-${source}`}
                aria-label={`Source ${source}`}
                onClick={(event) => {
                  event.preventDefault();
                  onCitation(source);
                }}
              >
                {part}
              </a>
            );
          return <Fragment key={partIndex}>{part}</Fragment>;
        })}
    </p>
  ));
}

function CommentCard({
  comment,
  number,
}: {
  comment: ElasticComment;
  number: number;
}) {
  const url = safeEvidenceUrl(comment.url);
  const isExcerpt = comment.text.length > 500;
  const excerpt = isExcerpt
    ? comment.text
        .slice(0, 500)
        .replace(/\s+\S*$/u, "")
        .trimEnd()
    : comment.text;
  const published = comment.publishedAt ? new Date(comment.publishedAt) : null;
  const validDate = published && !Number.isNaN(published.getTime());
  return (
    <article
      className="evidence-card"
      id={`elastic-source-${number}`}
      tabIndex={-1}
    >
      <div className="evidence-meta">
        <span>
          <strong>Source {number}</strong> · {comment.videoTitle}
        </span>
      </div>
      <blockquote>
        {excerpt}
        {isExcerpt ? "…" : ""}
      </blockquote>
      {isExcerpt && (
        <details className="original-record">
          <summary>Read full comment</summary>
          <p>{comment.text}</p>
        </details>
      )}
      <div className="evidence-footer">
        {validDate ? (
          <time dateTime={comment.publishedAt!}>
            {published.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </time>
        ) : (
          <span>Date not supplied</span>
        )}
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            View video
            <ExternalLink size={12} />
          </a>
        ) : (
          <span>Video link unavailable</span>
        )}
      </div>
    </article>
  );
}

export default function ElasticResearch({
  csrfToken,
  available,
  onContentChange,
}: {
  csrfToken: string;
  available: boolean;
  onContentChange: (hasContent: boolean) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [products, setProducts] = useState<string[]>([]);
  const [product, setProduct] = useState("");
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productsError, setProductsError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<ElasticScope>(fullScope);
  const [answer, setAnswer] = useState<ElasticAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const sourcesRef = useRef<HTMLDetailsElement>(null);
  const moreSourcesRef = useRef<HTMLDetailsElement>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const latestQuestion = useRef("");
  const selectedProduct = useRef("");
  const lastRequest = useRef<ElasticQueryInput | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const changeProduct = useCallback(
    (next: string) => {
      generation.current++;
      controller.current?.abort();
      controller.current = null;
      if (timer.current) clearTimeout(timer.current);
      const previousQuestion = latestQuestion.current;
      latestQuestion.current = "";
      lastRequest.current = null;
      selectedProduct.current = next;
      setProduct(next);
      setPrompt((draft) => draft || previousQuestion);
      setQuestion("");
      setScope(fullScope());
      setAnswer(null);
      setError("");
      setCancelled(false);
      setBusy(false);
      onContentChange(false);
    },
    [onContentChange],
  );

  useEffect(() => {
    if (!csrfToken || !available) {
      setProducts([]);
      setLoadingProducts(false);
      setProductsError("");
      if (selectedProduct.current) changeProduct("");
      return;
    }
    const abort = new AbortController();
    let active = true;
    let timedOut = false;
    setLoadingProducts(true);
    setProductsError("");
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, 15000);
    void (async () => {
      try {
        const response = await fetch("/api/elastic/products", {
          credentials: "same-origin",
          signal: abort.signal,
        });
        const result =
          (await response.json()) as Partial<ElasticProductsResponse> & {
            error?: string;
          };
        if (!active) return;
        if (!response.ok)
          throw new Error(
            result.error || "The product list could not be loaded.",
          );
        if (
          !Array.isArray(result.products) ||
          result.products.some(
            (item) => typeof item !== "string" || !item.trim(),
          )
        )
          throw new Error("The server returned an invalid product list.");
        const choices = [...new Set(result.products)];
        if (!choices.length)
          throw new Error("No products were found in the uploaded comments.");
        setProducts(choices);
        const next = choices.includes(selectedProduct.current)
          ? selectedProduct.current
          : choices.includes("Microsoft Teams")
            ? "Microsoft Teams"
            : choices[0];
        if (next !== selectedProduct.current) changeProduct(next);
      } catch (failure) {
        if (!active) return;
        setProducts([]);
        changeProduct("");
        setProductsError(
          timedOut
            ? "The product list did not load in time. Retry to choose a product."
            : failure instanceof Error
              ? failure.message
              : "The product list could not be loaded.",
        );
      } finally {
        clearTimeout(timeout);
        if (active) setLoadingProducts(false);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timeout);
      abort.abort();
    };
  }, [available, csrfToken, catalogAttempt, changeProduct]);

  useEffect(() => {
    return () => {
      generation.current++;
      controller.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const ask = async (
    text: string,
    nextScope: ElasticScope,
    clearDraft = false,
    retryBody?: ElasticQueryInput,
  ) => {
    const cleanQuestion = text.trim();
    if (
      cleanQuestion.length < 3 ||
      !csrfToken ||
      !available ||
      loadingProducts ||
      !product ||
      !products.includes(product) ||
      product !== selectedProduct.current ||
      (retryBody && retryBody.product !== product)
    )
      return;
    const revision = ++generation.current;
    controller.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    const abort = new AbortController();
    controller.current = abort;
    const body: ElasticQueryInput = retryBody ?? {
      product,
      question: cleanQuestion,
      scope: {
        ...nextScope,
        excludedVideoIds: [...nextScope.excludedVideoIds],
      },
      requestId: crypto.randomUUID(),
    };
    lastRequest.current = body;
    latestQuestion.current = cleanQuestion;
    setQuestion(cleanQuestion);
    setScope(nextScope);
    setAnswer(null);
    if (clearDraft) setPrompt("");
    setError("");
    setCancelled(false);
    setBusy(true);
    onContentChange(true);
    timer.current = setTimeout(() => {
      if (generation.current !== revision) return;
      generation.current++;
      abort.abort();
      setBusy(false);
      setError("Elastic did not finish in time. You can retry this question.");
    }, 165000);
    try {
      const response = await fetch("/api/elastic/query", {
        method: "POST",
        credentials: "same-origin",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ElasticAnswer & {
        error?: string;
      };
      if (generation.current !== revision || abort.signal.aborted) return;
      if (!response.ok) {
        throw new Error(
          result.error || "Elastic could not answer this question.",
        );
      }
      if (
        result.product !== body.product ||
        !Array.isArray(result.examples) ||
        result.examples.some((comment) => comment.product !== body.product)
      )
        throw new Error(
          "The response did not match the selected product. Please retry.",
        );
      if (
        result.requestId !== body.requestId ||
        result.question !== cleanQuestion ||
        result.scope.from !== nextScope.from ||
        result.scope.to !== nextScope.to ||
        result.scope.excludedVideoIds.length !==
          nextScope.excludedVideoIds.length ||
        result.scope.excludedVideoIds.some(
          (id) => !nextScope.excludedVideoIds.includes(id),
        )
      ) {
        throw new Error(
          "The response did not match this question and scope. Please retry.",
        );
      }
      setAnswer(result);
    } catch (failure) {
      if (generation.current !== revision || abort.signal.aborted) return;
      setError(
        failure instanceof Error
          ? failure.message
          : "Elastic could not answer this question.",
      );
    } finally {
      if (generation.current === revision) {
        if (timer.current) clearTimeout(timer.current);
        controller.current = null;
        setBusy(false);
      }
    }
  };

  const retry = () => {
    const body = lastRequest.current;
    if (
      !body ||
      busy ||
      body.product !== selectedProduct.current ||
      body.question !== latestQuestion.current ||
      JSON.stringify(body.scope) !== JSON.stringify(scope)
    )
      return;
    // Replay the exact submitted operation. The server may already have cached
    // its answer even when the browser did not receive the response.
    void ask(body.question, body.scope, false, body);
  };

  const cancel = () => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    if (timer.current) clearTimeout(timer.current);
    setBusy(false);
    setCancelled(true);
  };
  const largestVideo = answer?.metrics.videos.reduce<
    ElasticAnswer["metrics"]["videos"][number] | undefined
  >(
    (largest, video) =>
      !largest || video.count > largest.count ? video : largest,
    undefined,
  );

  return (
    <div className="elastic-workspace">
      <div className="elastic-product-choice">
        <label htmlFor="elastic-product">Product</label>
        <select
          id="elastic-product"
          value={product}
          disabled={
            loadingProducts || !products.length || !csrfToken || !available
          }
          onChange={(event) => changeProduct(event.target.value)}
        >
          {!product && <option value="">Choose a product</option>}
          {products.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
      {loadingProducts && (
        <p className="elastic-scope-note" role="status">
          Loading products…
        </p>
      )}
      {productsError && (
        <div className="elastic-catalog-error">
          <p className="availability-note" role="alert">
            {productsError}
          </p>
          <button
            className="text-button"
            onClick={() => setCatalogAttempt((value) => value + 1)}
          >
            Retry products
          </button>
        </div>
      )}
      {question && (
        <div className="elastic-prompt-history">
          <article className="message turn user">
            <span>You</span>
            <p>{question}</p>
          </article>
        </div>
      )}
      <form
        className="prompt-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void ask(prompt, scope, true);
        }}
      >
        <label className="sr-only" htmlFor="elastic-prompt">
          Message
        </label>
        <textarea
          id="elastic-prompt"
          rows={2}
          maxLength={2000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="What are the main complaints in these YouTube comments?"
        />
        <div className="composer-controls">
          <span className="elastic-provider">
            <Database size={15} />
            Elastic Agent
          </span>
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            disabled={
              prompt.trim().length < 3 ||
              busy ||
              !csrfToken ||
              !available ||
              loadingProducts ||
              !product
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <ArrowRight size={19} />
            )}
          </button>
        </div>
      </form>
      <p className="composer-caption">
        Ask about the uploaded YouTube comments. Text questions go directly to
        Elastic.
      </p>
      {!available && csrfToken && (
        <p className="availability-note">
          Elastic Agent is not configured. Choose Live discussions to use the
          existing research conversation.
        </p>
      )}
      {scope.excludedVideoIds.length > 0 && !answer && (
        <p className="elastic-scope-note">
          Current scope excludes {scope.excludedVideoIds.length} video
          {scope.excludedVideoIds.length === 1 ? "" : "s"}.
        </p>
      )}
      {busy && (
        <div className="research-progress" role="status">
          <div>
            <LoaderCircle className="spin" size={16} />
            <strong>Elastic is checking the comments…</strong>
          </div>
          <button className="text-button" onClick={cancel}>
            Cancel request
          </button>
        </div>
      )}
      {error && (
        <div className="error-message" role="alert">
          <CircleAlert size={17} />
          <div>{error}</div>
        </div>
      )}
      {cancelled && (
        <p className="elastic-scope-note" role="status">
          Request cancelled.
        </p>
      )}
      {(error || cancelled) && !busy && (
        <button className="text-button" onClick={retry}>
          Retry question
        </button>
      )}
      {answer && (
        <section
          className="findings-card elastic-answer"
          aria-labelledby="elastic-answer-title"
        >
          <div className="findings-heading">
            <span className="eyebrow">
              UPLOADED COMMENTS · {answer.product}
            </span>
            <span className="provenance-tag">YouTube · Elastic</span>
          </div>
          <h2 id="elastic-answer-title">What the comments say</h2>
          <div className="conclusion">
            <AnswerText
              text={answer.answer}
              sourceCount={answer.examples.length}
              onCitation={(source) => {
                if (sourcesRef.current) sourcesRef.current.open = true;
                if (source > 4 && moreSourcesRef.current)
                  moreSourcesRef.current.open = true;
                requestAnimationFrame(() => {
                  const card = document.getElementById(
                    `elastic-source-${source}`,
                  );
                  card?.focus({ preventScroll: true });
                  card?.scrollIntoView({ block: "center", behavior: "smooth" });
                });
              }}
            />
          </div>
          <div className="sample-counts" aria-label="Current comment scope">
            <span>
              <strong>{answer.metrics.scopedRecords}</strong> comments in scope
            </span>
            <span>
              <strong>{answer.metrics.distinctVideos}</strong> videos
            </span>
            <span>
              <strong>{answer.metrics.complaints}</strong> labeled complaints
            </span>
          </div>
          <p className="elastic-sample-note">
            Counts cover the full current scope. The supplied labels describe
            these comments, not product satisfaction.
          </p>
          {scope.excludedVideoIds.length > 0 && (
            <p className="elastic-scope-note">
              {scope.excludedVideoIds.length} video
              {scope.excludedVideoIds.length === 1 ? "" : "s"} excluded ·{" "}
              {answer.metrics.totalRecords} comments in the full upload.
            </p>
          )}
          <div className="finding-actions">
            {largestVideo && answer.metrics.distinctVideos > 1 && (
              <button
                className="secondary-button"
                onClick={() =>
                  void ask(latestQuestion.current, {
                    ...scope,
                    excludedVideoIds: [
                      ...scope.excludedVideoIds,
                      largestVideo.id,
                    ],
                  })
                }
              >
                <SlidersHorizontal size={15} />
                Exclude largest video
              </button>
            )}
            {scope.excludedVideoIds.length > 0 && (
              <button
                className="quiet-button"
                onClick={() => void ask(latestQuestion.current, fullScope())}
              >
                <RotateCcw size={14} />
                Reset scope
              </button>
            )}
          </div>
          {largestVideo && answer.metrics.distinctVideos > 1 && (
            <p className="elastic-scope-note">
              Largest video: {largestVideo.title} ({largestVideo.count}{" "}
              comments). Exclude it to check whether the answer changes.
            </p>
          )}
          {answer.examples.length > 0 && (
            <details className="elastic-source-quotes" ref={sourcesRef}>
              <summary>
                Inspect source comments ({answer.examples.length}){" "}
                <ChevronDown size={12} />
              </summary>
              {answer.examples.slice(0, 4).map((comment, index) => (
                <CommentCard
                  key={comment.id}
                  comment={comment}
                  number={index + 1}
                />
              ))}
              {answer.examples.length > 4 && (
                <details className="elastic-more-comments" ref={moreSourcesRef}>
                  <summary>
                    More source comments ({answer.examples.length - 4})
                  </summary>
                  {answer.examples.slice(4).map((comment, index) => (
                    <CommentCard
                      key={comment.id}
                      comment={comment}
                      number={index + 5}
                    />
                  ))}
                </details>
              )}
            </details>
          )}
          <details className="elastic-details">
            <summary>
              Evidence details <ChevronDown size={12} />
            </summary>
            <h3>Supplied labels</h3>
            <p>
              These labels were imported with the comments. They have not been
              independently verified.
            </p>
            <dl>
              <dt>Positive</dt>
              <dd>{answer.metrics.positive}</dd>
              <dt>Negative</dt>
              <dd>{answer.metrics.negative}</dd>
              <dt>Neutral</dt>
              <dd>{answer.metrics.neutral}</dd>
              <dt>Labeled complaints</dt>
              <dd>{answer.metrics.complaints}</dd>
            </dl>
            <h3>Comments by video</h3>
            <dl>
              {answer.metrics.videos.map((video) => (
                <Fragment key={video.id}>
                  <dt>{video.title}</dt>
                  <dd>{video.count}</dd>
                </Fragment>
              ))}
            </dl>
            {answer.metrics.categories.length > 0 && (
              <>
                <h3>Supplied categories</h3>
                <dl>
                  {answer.metrics.categories.map((category) => (
                    <Fragment key={category.name}>
                      <dt>{category.name}</dt>
                      <dd>{category.count}</dd>
                    </Fragment>
                  ))}
                </dl>
              </>
            )}
            {answer.limitations.length > 0 && (
              <>
                <h3>Sample limits</h3>
                <ul>
                  {answer.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              </>
            )}
            <h3>Elastic tool activity</h3>
            {answer.toolCalls.length ? (
              answer.toolCalls.map((call, index) => (
                <div className="elastic-trace" key={index}>
                  <strong>{call.tool}</strong>
                  {call.query && <p>{call.query}</p>}
                </div>
              ))
            ) : (
              <p>No tool activity was returned for this answer.</p>
            )}
            <p className="sample-note">
              Index: {answer.index} · Response generated{" "}
              {new Date(answer.generatedAt).toLocaleString()}
            </p>
          </details>
        </section>
      )}
    </div>
  );
}

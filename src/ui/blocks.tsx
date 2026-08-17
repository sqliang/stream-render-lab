/**
 * @file 根据 ContentBlock 类型按原始顺序选择对应的内容渲染器。
 */

import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { useArtifact, useArtifactIds, useAsset, useBlock, useSchema, useUiData } from '../runtime/react/runtime-react';

/**
 * 使用受限 Markdown 管线渲染文本内容。
 *
 * @param props - 已按 SSE 序号累计完成的 Markdown 源文本。
 * @returns 已消毒的 Markdown 内容元素。
 */
function InlineMarkdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {source}
      </Markdown>
    </div>
  );
}

/**
 * 读取并渲染 Markdown Block。
 *
 * @param props - 内容 Block 标识。
 * @returns Markdown Block 元素；类型不匹配时返回空。
 */
function MarkdownBlock({ blockId }: { blockId: string }) {
  const block = useBlock(blockId);
  if (block?.type !== 'markdown') {
    return null;
  }

  return <InlineMarkdown source={block.sourceContent} />;
}

/**
 * 通过稳定 Asset 关联渲染图片 Block。
 *
 * @param props - 内容 Block 标识。
 * @returns 图片卡片；资源尚未到达时返回空。
 */
function ImageBlock({ blockId }: { blockId: string }) {
  const block = useBlock(blockId);
  let assetId = '';
  if (block?.type === 'image') {
    assetId = block.assetId;
  }
  const asset = useAsset(assetId);
  if (!asset) {
    return null;
  }
  return (
    <figure className="image-card">
      <img src={asset.url} alt={asset.alt ?? ''} width={asset.width} height={asset.height} />
      <figcaption>{asset.alt}</figcaption>
    </figure>
  );
}

/**
 * 将 Schema 与流式数据分离读取后组合为富 UI 卡片。
 *
 * @param props - UI Schema Block 标识。
 * @returns 富 UI 卡片；Schema 尚未到达时返回空。
 */
function RichUiBlock({ blockId }: { blockId: string }) {
  const block = useBlock(blockId);
  let schemaId = '';
  if (block?.type === 'ui_schema') {
    schemaId = block.schemaId;
  }
  const schema = useSchema(schemaId);
  const data = useUiData(schemaId);
  if (!block || block.type !== 'ui_schema' || !schema) {
    return null;
  }
  return <section className="rich-card">
    <div className="rich-card-head">
      <div>
        <p className="card-kicker">STRUCTURED RESULTS</p>
        <h3>{schema.definition.title}</h3>
        <p>{schema.definition.subtitle}</p>
      </div>
      <span className="schema-dot" />
    </div>
    <div className="recommendation-list">
      {data?.items.map((item) => (
        <div className="recommendation" key={item.id}>
          <div className="recommendation-mark">✦</div>
          <div>
            <h4>{item.title}</h4>
            <p>{item.description}</p>
          </div>
          <span>{item.meta}</span>
        </div>
      ))}
      {(!data || data.items.length === 0) && (
        <>
          <div className="skeleton" />
          <div className="skeleton short" />
        </>
      )}
    </div>
  </section>;
}

/**
 * 渲染某个产物组内按索引排序的产物链接。
 *
 * @param props - 产物组 Block 标识。
 * @returns 产物列表。
 */
function ArtifactGroup({ blockId }: { blockId: string }) {
  const artifactIds = useArtifactIds(blockId);
  return (
    <section className="artifact-group">
      <p className="card-kicker">GENERATED ARTIFACTS</p>
      {artifactIds.map((id) => (
        <ArtifactRow key={id} artifactId={id} />
      ))}
    </section>
  );
}

/**
 * 通过 Artifact 到 Asset 的关联渲染单个下载项。
 *
 * @param props - 产物标识。
 * @returns 产物链接；关联资源缺失时返回空。
 */
function ArtifactRow({ artifactId }: { artifactId: string }) {
  const artifact = useArtifact(artifactId);
  const asset = useAsset(artifact?.assetId ?? '');
  if (!artifact || !asset) {
    return null;
  }
  return (
    <a className="artifact-row" href={asset.url} target="_blank" rel="noreferrer">
      <span>↓</span>
      <div>
        <strong>{artifact.name}</strong>
        <small>{artifact.mimeType}</small>
      </div>
      <i>查看</i>
    </a>
  );
}

/**
 * 根据 Block 类型选择专属渲染器，并保留上层提供的内容顺序。
 *
 * @param props - 需要渲染的 Block 标识。
 * @returns 与 Block 类型匹配的内容元素；Block 不存在时返回空。
 */
export function BlockRenderer({ blockId }: { blockId: string }) {
  const block = useBlock(blockId);
  if (!block) {
    return null;
  }
  if (block.type === 'markdown') {
    return <MarkdownBlock blockId={blockId} />;
  }
  if (block.type === 'image') {
    return <ImageBlock blockId={blockId} />;
  }
  if (block.type === 'ui_schema') {
    return <RichUiBlock blockId={blockId} />;
  }
  return <ArtifactGroup blockId={blockId} />;
}

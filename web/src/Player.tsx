import { Pause, Play, RotateCcw, RotateCw, X } from 'lucide-react';
import { t } from '../../src/shared/i18n';
import { useMemo } from 'react';
import { formatTime, ownerHref, player, playerStore, useStore } from './lib';
import { speakerNames } from './PodcastPanel';

const RATES = [1, 1.25, 1.5, 2, 0.75];

/** Lives outside the routes, so playback continues while you move around the app. */
export function Player() {
  const state = useStore(playerStore);
  const podcast = state.podcast;
  const duration = podcast?.duration ?? 0;
  const segments = useMemo(() => {
    if (!podcast || !duration) return [];
    return podcast.rounds
      .filter((r) => r.start !== undefined && r.end !== undefined)
      .map((r) => ({ left: (r.start! / duration) * 100, width: ((r.end! - r.start!) / duration) * 100, speaker: r.speaker }));
  }, [podcast, duration]);

  if (!podcast) return null;
  const names = speakerNames(podcast.speakers);
  const current = podcast.rounds.find((r) => r.start !== undefined && state.time >= r.start && state.time < (r.end ?? Infinity));
  const progress = duration ? Math.min(100, (state.time / duration) * 100) : 0;

  return (
    <div className="player">
      <div className="player-controls">
        <button className="icon" title={t('后退 15 秒')} onClick={() => player.skip(-15)}><RotateCcw size={16} /></button>
        <button className="player-play" title={state.playing ? t('暂停') : t('播放')} onClick={player.toggle}>
          {state.playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <button className="icon" title={t('前进 15 秒')} onClick={() => player.skip(15)}><RotateCw size={16} /></button>
      </div>
      <div className="player-main">
        <div className="player-line">
          <a className="player-title" href={ownerHref(state.paperId!, 'podcast', podcast.id)}>{podcast.title}</a>
          <span className="player-now">{current ? `${names[current.speaker]}：${current.text}` : ''}</span>
        </div>
        <div
          className="timeline"
          role="slider"
          aria-label={t('播放进度')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(state.time)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') player.skip(-5);
            if (e.key === 'ArrowRight') player.skip(5);
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            player.seek(((e.clientX - rect.left) / rect.width) * duration);
          }}
        >
          {segments.map((s, i) => (
            <i key={i} className={s.speaker === 1 ? 'b' : 'a'} style={{ left: `${s.left}%`, width: `${s.width}%` }} />
          ))}
          <div className="timeline-played" style={{ width: `${progress}%` }} />
          <div className="timeline-head" style={{ left: `${progress}%` }} />
        </div>
      </div>
      <div className="player-time mono">{formatTime(state.time)} / {formatTime(duration)}</div>
      <button
        className="player-rate mono"
        title={t('播放速度')}
        onClick={() => player.setRate(RATES[(RATES.indexOf(state.rate) + 1) % RATES.length])}
      >
        {state.rate}×
      </button>
      <button className="icon" title={t('关闭播放器')} onClick={player.close}><X size={16} /></button>
    </div>
  );
}

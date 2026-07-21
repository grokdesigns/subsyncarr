import { ProcessingEngine } from '../processingEngine';
import { StateManager } from '../stateManager';
import { findAllSrtFiles } from '../findAllSrtFiles';
import { findMatchingVideoFile } from '../findMatchingVideoFile';
import { generateAlassSubtitles } from '../generateAlassSubtitles';
import { computeVideoFingerprint } from '../videoFingerprint';

jest.mock('../findAllSrtFiles');
jest.mock('../findMatchingVideoFile');
jest.mock('../generateAlassSubtitles');
jest.mock('../generateFfsubsyncSubtitles');
jest.mock('../generateAutosubsyncSubtitles');
jest.mock('../videoFingerprint');

const mockedFindAllSrtFiles = findAllSrtFiles as jest.Mock;
const mockedFindMatchingVideoFile = findMatchingVideoFile as jest.Mock;
const mockedGenerateAlassSubtitles = generateAlassSubtitles as jest.Mock;
const mockedComputeVideoFingerprint = computeVideoFingerprint as jest.Mock;

describe('ProcessingEngine - processed fingerprint tracking', () => {
  const srtPath = '/media/movie.srt';
  const videoPath = '/media/movie.mkv';

  let engine: ProcessingEngine;
  let mockStateManager: {
    getProcessedRecord: jest.Mock;
    markProcessed: jest.Mock;
    shouldSkipEngine: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INCLUDE_ENGINES = 'alass';

    engine = new ProcessingEngine();
    mockStateManager = {
      getProcessedRecord: jest.fn().mockReturnValue(null),
      markProcessed: jest.fn(),
      shouldSkipEngine: jest.fn().mockReturnValue(false),
    };
    engine.stateManager = mockStateManager as unknown as StateManager;

    mockedFindAllSrtFiles.mockResolvedValue({ files: [srtPath], skippedCount: 0 });
    mockedFindMatchingVideoFile.mockReturnValue(videoPath);
  });

  it('skips the engine when a processed record matches the current video fingerprint', async () => {
    mockStateManager.getProcessedRecord.mockReturnValue({
      file_path: srtPath,
      engine: 'alass',
      video_path: videoPath,
      video_fingerprint: 'same-hash',
      processed_at: Date.now(),
    });
    mockedComputeVideoFingerprint.mockResolvedValue('same-hash');

    const completedEvents: unknown[] = [];
    engine.on('file:engine_completed', (payload) => completedEvents.push(payload));

    await engine.processRun({ includePaths: ['/media'], excludePaths: [] });

    expect(mockedGenerateAlassSubtitles).not.toHaveBeenCalled();
    expect(completedEvents).toEqual([
      expect.objectContaining({
        engine: 'alass',
        result: expect.objectContaining({ skipped: true, message: 'Already processed (video unchanged)' }),
      }),
    ]);
  });

  it('reprocesses when the video fingerprint no longer matches the processed record', async () => {
    mockStateManager.getProcessedRecord.mockReturnValue({
      file_path: srtPath,
      engine: 'alass',
      video_path: videoPath,
      video_fingerprint: 'old-hash',
      processed_at: Date.now(),
    });
    mockedComputeVideoFingerprint.mockResolvedValue('new-hash');
    mockedGenerateAlassSubtitles.mockResolvedValue({ success: true, message: 'Successfully processed' });

    await engine.processRun({ includePaths: ['/media'], excludePaths: [] });

    expect(mockedGenerateAlassSubtitles).toHaveBeenCalledWith(srtPath, videoPath);
    expect(mockStateManager.markProcessed).toHaveBeenCalledWith(srtPath, 'alass', videoPath, 'new-hash');
  });

  it('records a processed fingerprint after a fresh successful run', async () => {
    mockStateManager.getProcessedRecord.mockReturnValue(null);
    mockedComputeVideoFingerprint.mockResolvedValue('fresh-hash');
    mockedGenerateAlassSubtitles.mockResolvedValue({ success: true, message: 'Successfully processed' });

    await engine.processRun({ includePaths: ['/media'], excludePaths: [] });

    expect(mockStateManager.markProcessed).toHaveBeenCalledWith(srtPath, 'alass', videoPath, 'fresh-hash');
  });

  it('does not fingerprint the video when there is no prior processed record and the engine fails', async () => {
    mockStateManager.getProcessedRecord.mockReturnValue(null);
    mockedGenerateAlassSubtitles.mockResolvedValue({ success: false, message: 'boom' });

    await engine.processRun({ includePaths: ['/media'], excludePaths: [] });

    // Fingerprinting is lazy: never needed since there was no record to compare against and the run failed.
    expect(mockedComputeVideoFingerprint).not.toHaveBeenCalled();
    expect(mockStateManager.markProcessed).not.toHaveBeenCalled();
  });
});

describe('ProcessingEngine - concurrency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INCLUDE_ENGINES = 'alass';
    mockedComputeVideoFingerprint.mockResolvedValue('hash');
    mockedFindMatchingVideoFile.mockImplementation((srtPath: string) => srtPath.replace('.srt', '.mkv'));
  });

  it('keeps a new file flowing into a freed worker slot instead of waiting for the whole batch to drain', async () => {
    process.env.MAX_CONCURRENT_SYNC_TASKS = '2';
    const mockStateManager = {
      getProcessedRecord: jest.fn().mockReturnValue(null),
      markProcessed: jest.fn(),
      shouldSkipEngine: jest.fn().mockReturnValue(false),
    };
    // maxConcurrent is read in the constructor, so it must be created after the env var is set.
    const pooledEngine = new ProcessingEngine();
    pooledEngine.stateManager = mockStateManager as unknown as StateManager;

    const files = ['/media/a.srt', '/media/b.srt', '/media/c.srt'];
    mockedFindAllSrtFiles.mockResolvedValue({ files, skippedCount: 0 });

    let resolveA!: () => void;
    const aPending = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    mockedGenerateAlassSubtitles.mockImplementation(async (srtPath: string) => {
      if (srtPath === '/media/a.srt') {
        await aPending;
      }
      return { success: true, message: 'ok' };
    });

    const runPromise = pooledEngine.processRun({ includePaths: ['/media'], excludePaths: [] });

    // Drain the microtask queue: worker 1 should be stuck awaiting 'a', worker 2 should
    // have already finished 'b' and picked up 'c' — proving it didn't wait on worker 1.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const calledPaths = mockedGenerateAlassSubtitles.mock.calls.map(([srtPath]) => srtPath);
    expect(calledPaths).toEqual(expect.arrayContaining(['/media/a.srt', '/media/b.srt', '/media/c.srt']));

    resolveA();
    await runPromise;
  });
});

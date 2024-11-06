/**
 * Running a local relay server will allow you to hide your API key
 * and run custom logic on the server
 *
 * Set the local relay server address to:
 * REACT_APP_LOCAL_RELAY_SERVER_URL=http://localhost:8081
 *
 * This will also require you to set OPENAI_API_KEY= in a `.env` file
 * You can run it with `npm run relay`, in parallel with `npm start`
 */
const LOCAL_RELAY_SERVER_URL: string =
  process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';

import { useEffect, useRef, useCallback, useState } from 'react';

import { RealtimeClient } from '@openai/realtime-api-beta';
import { ItemType } from '@openai/realtime-api-beta/dist/lib/client.js';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { instructions } from '../utils/conversation_config.js';
import { WavRenderer } from '../utils/wav_renderer';

import { X, Edit, Zap, ArrowUp, ArrowDown, Mic } from 'react-feather';
import { Button } from '../components/button/Button';
import { Toggle } from '../components/toggle/Toggle';

import './ConsolePage.scss';

/**
 * Type for all event logs
 */
interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

// Функция для форматирования памяти в строку контекста
const getMemoryContext = (memory: {[key: string]: string[]}) => {
  if (Object.keys(memory).length === 0) return '';
  
  const memoryItems = Object.entries(memory)
    .map(([key, values]) => `${key}: ${values.join(', ')}`)
    .join('\n');
  
  return `
Here is what I remember about our previous conversations:
${memoryItems}

Please use this information in our conversation when relevant.
`;
};

// Изменим тип и инициализацию состояния memory
interface Memory {
  [key: string]: string[];
}

// Определим тип для функции setMemory
type SetMemoryFunction = React.Dispatch<React.SetStateAction<Memory>>;

// Определим тип для функции updateContext
type UpdateContextFunction = (memory: Memory) => void;

// В начале компонента, после объявления интерфейсов
const setupClientTools = (
  client: RealtimeClient, 
  setMemory: SetMemoryFunction, 
  updateContext: UpdateContextFunction
) => {
  client.addTool(
    {
      name: 'set_memory',
      description: 'Stores information in memory that can be recalled later',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key to store the information under'
          },
          value: {
            type: 'string',
            description: 'Information to remember'
          }
        },
        required: ['key', 'value']
      }
    },
    async ({ key, value }: { key: string; value: string }) => {
      setMemory((prev: Memory) => {
        const prevValues = prev[key] || [];
        const newMemory = {
          ...prev,
          [key]: [...prevValues, value]
        };
        localStorage.setItem('oracle_memory', JSON.stringify(newMemory));
        updateContext(newMemory);
        return newMemory;
      });
      return '';
    }
  );

  client.addTool(
    {
      name: 'clear_memory',
      description: 'Clears all stored memory',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    async () => {
      setMemory({});
      localStorage.removeItem('oracle_memory');
      updateContext({});
      return '';
    }
  );
};

export function ConsolePage() {
  /**
   * Ask user for API Key
   * If we're using the local relay server, we don't need this
   */
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
      prompt('OpenAI API Key') ||
      '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  /**
   * Instantiate:
   * - WavRecorder (speech input)
   * - WavStreamPlayer (speech output)
   * - RealtimeClient (API client)
   */
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
            apiKey: apiKey,
            dangerouslyAllowAPIKeyInBrowser: true,
          }
    )
  );

  /**
   * References for
   * - Rendering audio visualization (canvas)
   * - Autoscrolling event logs
   * - Timing delta for event log displays
   */
  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * All of our variables for displaying application state
   * - items are all conversation items (dialog)
   * - realtimeEvents are event logs, which can be expanded
   */
  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<{
    [key: string]: boolean;
  }>({});
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordingInterval, setRecordingInterval] = useState<NodeJS.Timeout | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [memory, setMemory] = useState<Memory>(() => {
    try {
      const savedMemory = localStorage.getItem('oracle_memory');
      if (!savedMemory) return {};
      
      const parsed = JSON.parse(savedMemory);
      const normalized: Memory = {};
      Object.entries(parsed).forEach(([key, value]) => {
        normalized[key] = Array.isArray(value) ? value : [value];
      });
      return normalized;
    } catch (e) {
      console.error('Failed to parse memory:', e);
      return {};
    }
  });

  // Определяем updateContext до его использования
  const updateContext = useCallback((memory: Memory) => {
    const memoryContext = getMemoryContext(memory);
    clientRef.current.updateSession({ 
      instructions: instructions + (memoryContext ? `\n\n${memoryContext}` : '')
    });
  }, []);

  // Инициализируем инструменты после создания всех необходимых состояний
  useEffect(() => {
    setupClientTools(clientRef.current, setMemory, updateContext);
  }, [updateContext]);

  /**
   * Utility for formatting the timing of logs
   */
  const formatTime = useCallback((timestamp: string) => {
    const startTime = startTimeRef.current;
    const t0 = new Date(startTime).valueOf();
    const t1 = new Date(timestamp).valueOf();
    const delta = t1 - t0;
    const hs = Math.floor(delta / 10) % 100;
    const s = Math.floor(delta / 1000) % 60;
    const m = Math.floor(delta / 60_000) % 60;
    const pad = (n: number) => {
      let s = n + '';
      while (s.length < 2) {
        s = '0' + s;
      }
      return s;
    };
    return `${pad(m)}:${pad(s)}.${pad(hs)}`;
  }, []);

  /**
   * When you click the API key
   */
  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);

  /**
   * Connect to conversation:
   * WavRecorder taks speech input, WavStreamPlayer output, client is API client
   */
  const connectConversation = useCallback(async () => {
    setIsConnecting(true);
    
    try {
      const client = clientRef.current;
      const wavRecorder = wavRecorderRef.current;
      const wavStreamPlayer = wavStreamPlayerRef.current;

      // Обновляем контекст с текущей памятью
      updateContext(memory);

      // Set state variables
      startTimeRef.current = new Date().toISOString();
      setRealtimeEvents([]);
      setItems(client.conversation.getItems());

      // Connect to microphone
      await wavRecorder.begin();

      // Connect to audio output
      await wavStreamPlayer.connect();
      // @ts-ignore - OpenAI Realtime API Beta types are outdated and don't include all available voices.
      // 'ash' is a valid voice option according to the latest API but not yet reflected in the type definitions
      client.updateSession({ voice: 'ash' });

      // Connect to realtime API
      await client.connect();

      // Automatically set to manual mode
      client.updateSession({ turn_detection: null });
      setCanPushToTalk(true);
      setIsConnected(true);
    } catch (error) {
      console.error('Connection failed:', error);
    } finally {
      setIsConnecting(false);
    }
  }, [memory, updateContext]);

  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * Set up render loops for the visualization canvas
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#0099ff',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#009900',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  /**
   * Core RealtimeClient and audio capture setup
   * Set all of our instructions, tools, events and more
   */
  useEffect(() => {
    // Get refs
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    // Set instructions
    client.updateSession({ instructions: instructions });
    // Set transcription, otherwise we don't get user transcriptions back
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    // handle realtime events from client + server for event logging
    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          // if we receive multiple events in a row, aggregate them for display purposes
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    client.on('error', (event: any) => console.error(event));
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });
    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    // Set VAD by default
    client.updateSession({ turn_detection: { type: 'server_vad' } });

    return () => {
      // cleanup; resets to defaults
      client.reset();
    };
  }, []);

  /**
   * In push-to-talk mode, start recording
   * .appendInputAudio() for each sample
   */
  const toggleRecording = async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    if (!isRecording) {
      // Start recording
      setIsRecording(true);
      
      // Interrupt any playing audio
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
      
      // Start recording
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
      
      // Start timer
      setRecordingTime(0);
      const interval = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      setRecordingInterval(interval);
    } else {
      // Stop recording
      setIsRecording(false);
      
      // Clear timer
      if (recordingInterval) {
        clearInterval(recordingInterval);
        setRecordingInterval(null);
      }
      setRecordingTime(0);
      
      // Stop recording and send message
      await wavRecorder.pause();
      client.createResponse();
    }
  };

  /**
   * Switch between Manual <> VAD mode for communication
   */
  const changeTurnEndType = async (value: string) => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    
    if (value === 'none' && wavRecorder.getStatus() === 'recording') {
      await wavRecorder.pause();
    }
    
    client.updateSession({
      turn_detection: value === 'none' ? null : { type: 'server_vad' },
    });
    
    if (value === 'server_vad' && client.isConnected()) {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
    
    setCanPushToTalk(value === 'none');
  };

  const sendTextMessage = async () => {
    if (!textInput.trim()) return;
    
    const client = clientRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // Interrupt any playing audio
    const trackSampleOffset = await wavStreamPlayer.interrupt();
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset;
      await client.cancelResponse(trackId, offset);
    }

    // Send text message using sendUserMessageContent
    await client.sendUserMessageContent([{ 
      type: 'input_text',
      text: textInput 
    }]);
    
    setTextInput(''); // Clear input after sending
  };

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <span style={{ color: 'white' }}>Oracle AI</span>
        </div>
        <div className="content-api-key">
          {!LOCAL_RELAY_SERVER_URL && (
            <Button
              icon={Edit}
              iconPosition="end"
              buttonStyle="flush"
              label={`api key: ${apiKey.slice(0, 3)}...`}
              onClick={() => resetAPIKey()}
            />
          )}
        </div>
      </div>
      <div className="content-main">
        <div className="content-logs">
          <div className="visualization">
            <div className="visualization-entry client">
              <canvas ref={clientCanvasRef} />
            </div>
            <div className="visualization-entry server">
              <canvas ref={serverCanvasRef} />
            </div>
          </div>
          <div className="content-block conversation">
            <div className="content-block-body" data-conversation-content>
              {!items.length && (
                <div className="empty-state">
                  <div className="waveform-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 3V21M9 6V18M6 8V16M3 11V13M15 4V20M18 7V17M21 9V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div>Conversation will appear here</div>
                </div>
              )}
              {items.map((conversationItem, i) => {
                return (
                  <div 
                    className={`conversation-item ${conversationItem.role || ''}`} 
                    key={conversationItem.id}
                  >
                    <div className="speaker">
                      <div>
                        {(conversationItem.role || conversationItem.type).replaceAll('_', ' ')}
                      </div>
                      <div
                        className="close"
                        onClick={() => deleteConversationItem(conversationItem.id)}
                      >
                        <X />
                      </div>
                    </div>
                    <div className="speaker-content">
                      {/* tool response */}
                      {conversationItem.type === 'function_call_output' && (
                        <div>{conversationItem.formatted.output}</div>
                      )}
                      {/* tool call */}
                      {!!conversationItem.formatted.tool && (
                        <div>
                          {conversationItem.formatted.tool.name}(
                          {conversationItem.formatted.tool.arguments})
                        </div>
                      )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === 'user' && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              (conversationItem.formatted.audio?.length
                                ? '(awaiting transcript)'
                                : conversationItem.formatted.text ||
                                  '(item sent)')}
                          </div>
                        )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === 'assistant' && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              conversationItem.formatted.text ||
                              '(truncated)'}
                          </div>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="content-actions">
            {isConnected && !isConnecting && (
              <>
                <div className="input-container">
                  <input
                    type="text"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && sendTextMessage()}
                    placeholder="Type a message..."
                    disabled={!isConnected}
                  />
                  <Button
                    icon={ArrowUp}
                    buttonStyle="regular"
                    disabled={!isConnected || !textInput.trim()}
                    onClick={sendTextMessage}
                  />
                </div>
                {canPushToTalk && (
                  <Button
                    icon={Mic}
                    buttonStyle={isRecording ? 'alert' : 'regular'}
                    disabled={!isConnected || !canPushToTalk}
                    onClick={toggleRecording}
                    label={isRecording ? `${recordingTime}s` : 'Record'}
                    className={`record-button ${isRecording ? 'recording' : ''}`}
                  />
                )}
              </>
            )}
            <Button
              icon={isConnecting ? undefined : (isConnected ? X : Zap)}
              buttonStyle={isConnected ? 'regular' : 'action'}
              onClick={isConnected ? disconnectConversation : connectConversation}
              label={isConnecting ? 'Connecting...' : (isConnected ? 'End session' : 'Talk to Oracle')}
              disabled={isConnecting}
              className={isConnected ? 'disconnect-button' : 'connect-button'}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

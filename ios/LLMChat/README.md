# LLM Chat (iOS)

A simple SwiftUI chat client for [llm-gateway](../../llm-gateway/README.md):
answers stream in as they're generated, a stop button cancels a generation,
and errors from the gateway (rate limit, busy queue, context overflow, bad
key) are shown in plain Russian. The whole history goes with every request,
so the model remembers the conversation until "Новый чат" is tapped.

- iOS 17+, no dependencies. Open `LLMChat.xcodeproj` in Xcode 16+.
- Settings (gear icon): server address, API key, device name, model. The
  device name goes in the `X-Client-Name` header, so the gateway's live log
  can tell clients apart. It defaults to the simulator's name.
- ATS allows plain HTTP, because the gateway runs on the local network.

## Two simulators at once

```bash
cd ios/LLMChat
xcodebuild -project LLMChat.xcodeproj -scheme LLMChat -destination 'generic/platform=iOS Simulator' -derivedDataPath build build
APP=build/Build/Products/Debug-iphonesimulator/LLMChat.app

xcrun simctl boot "iPhone 17"; xcrun simctl boot "iPhone 17 Pro"; open -a Simulator
for sim in "iPhone 17" "iPhone 17 Pro"; do
  xcrun simctl install "$sim" $APP
  xcrun simctl spawn "$sim" defaults write world.advent.llmchat serverURL http://<mac-lan-ip>:8088
  xcrun simctl spawn "$sim" defaults write world.advent.llmchat apiKey <key from llm-gateway/.env>
  xcrun simctl launch "$sim" world.advent.llmchat
done
```

Give each simulator its own key (for example `owner` and `tester`) to show
the per-client rate limit. Watch the requests come in at
`http://localhost:8088/logs` on the Mac.

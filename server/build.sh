#!/bin/sh
# src/ parçalarını Cloudflare'e yapıştırılacak tek dosyada birleştirir
cd "$(dirname "$0")" && cat src/core.js src/panel.js src/entry.js > worker.js && echo "worker.js hazır"

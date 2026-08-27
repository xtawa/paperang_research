# 02 — Printer-control architecture inside the APK

This chapter describes what is **directly visible in the recovered DEX metadata**.

## 1. Two printer library generations

### Older compatibility layer

Namespace:

```text
com.paperang.lib.print
```

Examples include:

```text
com.paperang.lib.print.constants.PrinterConstants
com.paperang.lib.print.constants.PrinterConstants$BtCommand
com.paperang.lib.print.constants.PrinterConstants$BtCommand$Density
com.paperang.lib.print.constants.PrinterConstants$BtCommand$OffTime
```

This layer contains many legacy Paperang model strings and basic printer constants.

### Newer/current stack

Namespace:

```text
com.paperang.libprinter
```

This is the richer implementation and contains transports, protocol parsers, printing modes, device state handling, firmware/update functions, label support, and newer device families.

## 2. Local transport layer

### 2.1 Classic Bluetooth

APK-confirmed classes:

```text
com.paperang.libprinter.printer.connect.bluetooth.manage.BluetoothManager
com.paperang.libprinter.printer.connect.bluetooth.thread.ConnectThread
com.paperang.libprinter.printer.connect.bluetooth.thread.SendMsgThread_Bluetooth
```

`SendMsgThread_Bluetooth` owns:

```text
android.bluetooth.BluetoothSocket socket
java.io.InputStream inputStream
java.io.OutputStream outputStream
```

and exposes methods including:

```text
run
write
closeSocket
stopThread
```

The DEX string pool also contains the standard SPP UUID:

```text
00001101-0000-1000-8000-00805f9b34fb
```

This is strong evidence that some supported devices are driven as a serial byte stream over classic Bluetooth SPP.

`BluetoothManager` exposes a large device-facing API including:

```text
connect / connectBT
startSendMessage
sendData / sendDataByMtu
sendData_Pro0207
registerCrcKey_0207 / sendCRCKey_0207
sendImage / sendImageBytes_Paperang
sendUniPrintData_Paperang / sendMultiPrintData_Paperang
sendDensity
sendFeedLine / sendFeedLine_02_07 / sendFeedLine_A5
sendPaperType / sendPaperType_0207
sendPowerDownTime
sendPrintData_17
sendSelfTest
queryBatteryStatus
queryPrinterVersion
queryPrinterType
splitDataByContentLength
```

The names alone establish a layered flow: **high-level print operation → protocol-specific packet generation → splitting → transport send thread**.

### 2.2 BLE / GATT

APK-confirmed classes:

```text
com.paperang.libprinter.printer.connect.ble.RequestQueue
com.paperang.libprinter.printer.connect.ble.manage.BleManager
com.paperang.libprinter.printer.connect.ble.manage.Constants
```

`BleManager` includes methods such as:

```text
connectLeDevice
dataSending
sendData
sendDataByMtu
sendData_Pro0207
sendMessage
onRecvBleData
receiveData
requestConnectionPriority_High
setNotify
refreshGattCache
```

The DEX logs contain messages such as:

```text
--- BluetoothGatt.GATT_SUCCESS
--- Service uuid[
--- character uuid[
Paperang --> dataSending getGatt() is null
```

The current DEX contains several candidate GATT UUID families:

```text
0000FF00-0000-1000-8000-00805F9B34FB
0000FF01-0000-1000-8000-00805F9B34FB
0000FF02-0000-1000-8000-00805F9B34FB
0000FF03-0000-1000-8000-00805F9B34FB

0000FF00-C243-40B9-AC41-A10BA3AD5D1A
0000FF01-C243-40B9-AC41-A10BA3AD5D1A
0000FF02-C243-40B9-AC41-A10BA3AD5D1A
0000FF03-C243-40B9-AC41-A10BA3AD5D1A

0000ae00-0000-1000-8000-00805f9b34fb
0000ae01-0000-1000-8000-00805f9b34fb
0000ae02-0000-1000-8000-00805f9b34fb
```

The relevant constant fields are named:

```text
UUID_SERVICE_E1_E2
UUID_SERVICE_H1
UUID_SERVICE_X2_F1
UUID_CHARACTER_E1_WRITE_MCU
UUID_CHARACTER_E1_NOTIFICATION_MCU
UUID_CHARACTER_X2_WRITE_MCU
...
```

However, their `<clinit>` bytecode is NOP-protected, so the exact **field → UUID → model** mapping is not asserted here. Use `tools/ble_probe.py` on actual hardware to resolve it empirically.

### 2.3 Wi-Fi / TCP

The printer library also contains:

```text
com.paperang.libprinter.printer.connect.wifi.TCPServer
com.paperang.libprinter.printer.connect.wifi.WifiConnectManager
```

and BLE manager commands for opening/configuring Wi-Fi and querying network state. That implies BLE may be used as a provisioning/control channel for devices that later transfer data over Wi-Fi/TCP.

## 3. Protocol dispatch layer

The abstract/dispatcher class:

```text
com.paperang.libprinter.printer.device.protocol.Protocol
```

has static IDs:

```text
PROTOCOL_UNKNOWN = -1
PROTOCOL_02      = 0
PROTOCOL_07      = 1
PROTOCOL_A5      = 2
PROTOCOL_17      = 3
```

and methods:

```text
checkProtocolByHead
getContentLenByProtocol
getPackageLenByHead
isRightProtocolData
analyseData
analyseLastData
dispatchData
parseData
receiveData
```

This is a stream parser: receive bytes, identify protocol by leading byte, calculate packet length, validate, then dispatch to the corresponding parser.

`ProtocolParser` stores temporary bytes and the current protocol, which is consistent with handling partial Bluetooth/GATT reads.

## 4. Print data model and image pipeline

`PrintModel` stores:

```text
Bitmap bitmap
byte[] bitmapBytes
int copies
int imageType
boolean isNeedFeedLine
```

The app includes image-processing classes such as:

```text
ProcessNoneBmpAsyncTask
ProcessTextBmpAsyncTask
ProcessThresholdBmpAsyncTask
ProcessGrayBmpAsyncTask
ProcessBmpToByteArrayTask
ProcessBmpRankToByteArrayTask
ProcessBmpToHfmTask
ProcessBmpUtil
```

The printer layer further includes:

```text
PaperangPrintModeFactory
PrintModeNormal
PrintModeGrayRank4
PrintModeGrayRank8
PrintModeGrayRank12
PrintModeGrayRank16
GrayPrinterDataUtil
GrayscaleUtil
```

Therefore the app's printing path is approximately:

```text
text / image / bitmap
        ↓
resize / render / threshold / grayscale
        ↓
printer-specific raster byte array
        ↓
PrintModel / print mode
        ↓
protocol-specific print packets
        ↓
chunk / MTU / send queue
        ↓
BluetoothSocket OR BLE characteristic OR network channel
        ↓
printer response → protocol parser → callbacks
```

## 5. Device state is actively queried and parsed

The library is not a one-way “send bitmap and forget” driver. Callback/method names show handling for:

- battery
- printer version/model/SN
- paper missing / paper jam
- idle status
- density
- printed mileage
- label info / UID
- supported paper widths
- print start/end readiness
- retries and send completion

This explains why the official app can gate a print job based on current hardware status and adapt protocol behavior by device generation.

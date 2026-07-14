#define UNICODE
#define _UNICODE
#define _WIN32_WINNT 0x0A00
#define NTDDI_VERSION 0x0A000000
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <netioapi.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "advapi32.lib")

namespace
{
    const wchar_t* kControlClass = L"TaskbarNetworkSpeed.Control";
    const wchar_t* kDisplayClass = L"TaskbarNetworkSpeed.Display";
    const wchar_t* kHistoryClass = L"TaskbarNetworkSpeed.History";
    const wchar_t* kMutexName = L"Local\\TaskbarNetworkSpeed-PC-HELP";
    const wchar_t* kRunKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const wchar_t* kRunValue = L"TaskbarNetworkSpeed";
    const wchar_t* kSettingsKey = L"Software\\TaskbarNetworkSpeed";
    const wchar_t* kDisplayModeValue = L"DisplayMode";

    const UINT_PTR kTimerId = 1;
    const UINT kCommandStartup = 1001;
    const UINT kCommandExit = 1002;
    const UINT kCommandHistory = 1003;
    const UINT kCommandSeparate = 1004;
    const UINT kCommandTotal = 1005;
    const UINT kCommandResetHistory = 1006;
    const UINT kShowContextMenuMessage = WM_APP + 1;
    const size_t kMaxHistoryDays = 3660;

    enum class DisplayMode : DWORD
    {
        Separate = 0,
        Total = 1
    };

    struct DayUsage
    {
        int date = 0;
        ULONGLONG downloadBytes = 0;
        ULONGLONG uploadBytes = 0;
    };

    HINSTANCE g_instance = nullptr;
    HWND g_controller = nullptr;
    HWND g_display = nullptr;
    HWND g_taskbar = nullptr;
    HWND g_historyWindow = nullptr;
    HANDLE g_mutex = nullptr;
    HHOOK g_mouseHook = nullptr;

    UINT g_dpi = 96;
    int g_width = 112;
    int g_height = 42;
    int g_historyScroll = 0;

    bool g_sampleValid = false;
    DWORD g_interfaceIndex = 0;
    ULONGLONG g_previousIn = 0;
    ULONGLONG g_previousOut = 0;
    ULONGLONG g_previousTick = 0;
    double g_downloadRate = 0.0;
    double g_uploadRate = 0.0;

    DisplayMode g_displayMode = DisplayMode::Total;
    std::wstring g_downloadText = L"↓ 0 KB/s";
    std::wstring g_uploadText = L"↑ 0 KB/s";
    std::wstring g_totalText = L"0 KB/s";

    std::vector<DayUsage> g_history;
    std::wstring g_historyPath;
    bool g_historyDirty = false;
    ULONGLONG g_bytesSinceHistorySave = 0;
    unsigned int g_secondsSinceHistorySave = 0;
    unsigned int g_timerTicks = 0;

    int Scale(int logicalPixels)
    {
        return MulDiv(logicalPixels, static_cast<int>(g_dpi), 96);
    }

    int ScaleForWindow(HWND window, int logicalPixels)
    {
        UINT dpi = GetDpiForWindow(window);
        if (dpi == 0)
            dpi = 96;
        return MulDiv(logicalPixels, static_cast<int>(dpi), 96);
    }

    bool IsLightTheme()
    {
        DWORD value = 1;
        DWORD size = sizeof(value);
        RegGetValueW(
            HKEY_CURRENT_USER,
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
            L"SystemUsesLightTheme",
            RRF_RT_REG_DWORD,
            nullptr,
            &value,
            &size);
        return value != 0;
    }

    bool IsRunAtStartupEnabled()
    {
        HKEY key = nullptr;
        if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS)
            return false;

        const LONG result = RegQueryValueExW(key, kRunValue, nullptr, nullptr, nullptr, nullptr);
        RegCloseKey(key);
        return result == ERROR_SUCCESS;
    }

    void SetRunAtStartup(bool enabled)
    {
        HKEY key = nullptr;
        if (RegCreateKeyExW(HKEY_CURRENT_USER, kRunKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS)
            return;

        if (enabled)
        {
            wchar_t path[MAX_PATH] = {};
            GetModuleFileNameW(nullptr, path, MAX_PATH);
            const std::wstring command = L"\"" + std::wstring(path) + L"\" --startup";
            RegSetValueExW(
                key,
                kRunValue,
                0,
                REG_SZ,
                reinterpret_cast<const BYTE*>(command.c_str()),
                static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t)));
        }
        else
        {
            RegDeleteValueW(key, kRunValue);
        }
        RegCloseKey(key);
    }

    DisplayMode LoadDisplayMode()
    {
        DWORD value = static_cast<DWORD>(DisplayMode::Total);
        DWORD size = sizeof(value);
        if (RegGetValueW(
                HKEY_CURRENT_USER,
                kSettingsKey,
                kDisplayModeValue,
                RRF_RT_REG_DWORD,
                nullptr,
                &value,
                &size) != ERROR_SUCCESS)
        {
            return DisplayMode::Total;
        }
        return value == static_cast<DWORD>(DisplayMode::Separate)
            ? DisplayMode::Separate
            : DisplayMode::Total;
    }

    void SaveDisplayMode()
    {
        HKEY key = nullptr;
        if (RegCreateKeyExW(HKEY_CURRENT_USER, kSettingsKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS)
            return;

        const DWORD value = static_cast<DWORD>(g_displayMode);
        RegSetValueExW(
            key,
            kDisplayModeValue,
            0,
            REG_DWORD,
            reinterpret_cast<const BYTE*>(&value),
            sizeof(value));
        RegCloseKey(key);
    }

    std::wstring ModuleDirectory()
    {
        wchar_t path[32768] = {};
        const DWORD length = GetModuleFileNameW(nullptr, path, static_cast<DWORD>(std::size(path)));
        if (length == 0 || length >= std::size(path))
            return L".";

        std::wstring directory(path, length);
        const size_t separator = directory.find_last_of(L"\\/");
        return separator == std::wstring::npos ? L"." : directory.substr(0, separator);
    }

    int CurrentDate()
    {
        SYSTEMTIME time = {};
        GetLocalTime(&time);
        return static_cast<int>(time.wYear) * 10000
            + static_cast<int>(time.wMonth) * 100
            + static_cast<int>(time.wDay);
    }

    bool IsValidDateValue(int date)
    {
        const int year = date / 10000;
        const int month = (date / 100) % 100;
        const int day = date % 100;
        return year >= 2000 && year <= 3000
            && month >= 1 && month <= 12
            && day >= 1 && day <= 31;
    }

    void NormalizeHistory()
    {
        g_history.erase(
            std::remove_if(g_history.begin(), g_history.end(), [](const DayUsage& item)
            {
                return !IsValidDateValue(item.date);
            }),
            g_history.end());

        std::sort(g_history.begin(), g_history.end(), [](const DayUsage& left, const DayUsage& right)
        {
            return left.date < right.date;
        });

        std::vector<DayUsage> merged;
        merged.reserve(g_history.size());
        for (const DayUsage& item : g_history)
        {
            if (!merged.empty() && merged.back().date == item.date)
            {
                merged.back().downloadBytes += item.downloadBytes;
                merged.back().uploadBytes += item.uploadBytes;
            }
            else
            {
                merged.push_back(item);
            }
        }

        if (merged.size() > kMaxHistoryDays)
            merged.erase(merged.begin(), merged.begin() + (merged.size() - kMaxHistoryDays));
        g_history.swap(merged);
    }

    void LoadHistory()
    {
        g_historyPath = ModuleDirectory() + L"\\history.tsv";
        FILE* file = nullptr;
        if (_wfopen_s(&file, g_historyPath.c_str(), L"rt") != 0 || !file)
            return;

        DayUsage item = {};
        while (fwscanf_s(
                   file,
                   L"%d\t%llu\t%llu",
                   &item.date,
                   &item.downloadBytes,
                   &item.uploadBytes) == 3)
        {
            g_history.push_back(item);
            item = {};
        }
        fclose(file);
        NormalizeHistory();
    }

    bool SaveHistory()
    {
        if (!g_historyDirty || g_historyPath.empty())
            return true;

        const std::wstring temporaryPath = g_historyPath + L".tmp";
        FILE* file = nullptr;
        if (_wfopen_s(&file, temporaryPath.c_str(), L"wt") != 0 || !file)
            return false;

        bool writeSucceeded = true;
        for (const DayUsage& item : g_history)
        {
            if (fwprintf(
                    file,
                    L"%08d\t%llu\t%llu\n",
                    item.date,
                    item.downloadBytes,
                    item.uploadBytes) < 0)
            {
                writeSucceeded = false;
                break;
            }
        }
        if (fclose(file) != 0)
            writeSucceeded = false;

        if (!writeSucceeded
            || !MoveFileExW(
                temporaryPath.c_str(),
                g_historyPath.c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        {
            DeleteFileW(temporaryPath.c_str());
            return false;
        }

        g_historyDirty = false;
        g_bytesSinceHistorySave = 0;
        g_secondsSinceHistorySave = 0;
        return true;
    }

    void AddTrafficToHistory(ULONGLONG downloadBytes, ULONGLONG uploadBytes)
    {
        if (downloadBytes == 0 && uploadBytes == 0)
            return;

        const int today = CurrentDate();
        if (g_history.empty() || g_history.back().date != today)
        {
            g_history.push_back({ today, 0, 0 });
            if (g_history.size() > kMaxHistoryDays)
                g_history.erase(g_history.begin());
        }

        g_history.back().downloadBytes += downloadBytes;
        g_history.back().uploadBytes += uploadBytes;
        g_historyDirty = true;
        g_bytesSinceHistorySave += downloadBytes + uploadBytes;
    }

    std::wstring FormatRate(double bytesPerSecond)
    {
        wchar_t text[64] = {};
        if (bytesPerSecond < 1024.0)
            return L"0 KB/s";

        const double kilobytes = bytesPerSecond / 1024.0;
        if (kilobytes < 10.0)
            swprintf_s(text, L"%.1f KB/s", kilobytes);
        else if (kilobytes < 1024.0)
            swprintf_s(text, L"%.0f KB/s", kilobytes);
        else
        {
            const double megabytes = kilobytes / 1024.0;
            if (megabytes < 100.0)
                swprintf_s(text, L"%.1f MB/s", megabytes);
            else
                swprintf_s(text, L"%.0f MB/s", megabytes);
        }
        return text;
    }

    std::wstring FormatBytes(ULONGLONG bytes)
    {
        static const wchar_t* units[] = { L"B", L"KB", L"MB", L"GB", L"TB" };
        double value = static_cast<double>(bytes);
        size_t unit = 0;
        while (value >= 1024.0 && unit + 1 < std::size(units))
        {
            value /= 1024.0;
            ++unit;
        }

        wchar_t text[64] = {};
        if (unit == 0)
            swprintf_s(text, L"%llu B", bytes);
        else if (value < 10.0)
            swprintf_s(text, L"%.2f %s", value, units[unit]);
        else if (value < 100.0)
            swprintf_s(text, L"%.1f %s", value, units[unit]);
        else
            swprintf_s(text, L"%.0f %s", value, units[unit]);
        return text;
    }

    std::wstring FormatDate(int date)
    {
        wchar_t text[32] = {};
        swprintf_s(text, L"%02d/%02d/%04d", date % 100, (date / 100) % 100, date / 10000);
        return text;
    }

    bool ReadNetworkCounters(ULONGLONG& bytesIn, ULONGLONG& bytesOut, DWORD& interfaceIndex)
    {
        DWORD bestIndex = 0;
        const IPAddr destination = inet_addr("8.8.8.8");
        if (GetBestInterface(destination, &bestIndex) != NO_ERROR)
            return false;

        MIB_IF_ROW2 row = {};
        row.InterfaceIndex = bestIndex;
        if (GetIfEntry2(&row) != NO_ERROR || row.OperStatus != IfOperStatusUp)
            return false;

        interfaceIndex = bestIndex;
        bytesIn = row.InOctets;
        bytesOut = row.OutOctets;
        return true;
    }

    void UpdateNetworkRates()
    {
        ULONGLONG bytesIn = 0;
        ULONGLONG bytesOut = 0;
        DWORD interfaceIndex = 0;
        const ULONGLONG tick = GetTickCount64();

        if (!ReadNetworkCounters(bytesIn, bytesOut, interfaceIndex))
        {
            g_sampleValid = false;
            g_downloadRate = 0.0;
            g_uploadRate = 0.0;
        }
        else if (g_sampleValid
            && interfaceIndex == g_interfaceIndex
            && tick > g_previousTick
            && bytesIn >= g_previousIn
            && bytesOut >= g_previousOut)
        {
            const ULONGLONG downloadDelta = bytesIn - g_previousIn;
            const ULONGLONG uploadDelta = bytesOut - g_previousOut;
            const double elapsedSeconds = (tick - g_previousTick) / 1000.0;
            g_downloadRate = downloadDelta / elapsedSeconds;
            g_uploadRate = uploadDelta / elapsedSeconds;
            AddTrafficToHistory(downloadDelta, uploadDelta);
        }
        else
        {
            g_downloadRate = 0.0;
            g_uploadRate = 0.0;
        }

        if (interfaceIndex != 0)
        {
            g_sampleValid = true;
            g_interfaceIndex = interfaceIndex;
            g_previousIn = bytesIn;
            g_previousOut = bytesOut;
            g_previousTick = tick;
        }

        g_uploadText = L"↑ " + FormatRate(g_uploadRate);
        g_downloadText = L"↓ " + FormatRate(g_downloadRate);
        g_totalText = FormatRate(g_downloadRate + g_uploadRate);
    }

    void PositionDisplay()
    {
        if (!IsWindow(g_display) || !IsWindow(g_taskbar))
            return;

        RECT taskbarRect = {};
        if (!GetWindowRect(g_taskbar, &taskbarRect))
            return;

        g_dpi = GetDpiForWindow(g_taskbar);
        if (g_dpi == 0)
            g_dpi = 96;
        g_width = Scale(112);
        g_height = Scale(42);

        int screenX = taskbarRect.right - g_width - Scale(190);
        int screenY = static_cast<int>(taskbarRect.top)
            + std::max(0, (static_cast<int>(taskbarRect.bottom - taskbarRect.top) - g_height) / 2);

        HWND notificationArea = FindWindowExW(g_taskbar, nullptr, L"TrayNotifyWnd", nullptr);
        RECT notifyRect = {};
        if (notificationArea && GetWindowRect(notificationArea, &notifyRect))
        {
            const bool notificationsOnLeft =
                (notifyRect.left + notifyRect.right) < (taskbarRect.left + taskbarRect.right);
            screenX = notificationsOnLeft
                ? notifyRect.right + Scale(18)
                : notifyRect.left - g_width - Scale(18);
        }

        screenX = std::max(static_cast<int>(taskbarRect.left) + Scale(4),
            std::min(screenX, static_cast<int>(taskbarRect.right) - g_width - Scale(4)));

        POINT childPoint = { screenX, screenY };
        const LONG_PTR taskbarExStyle = GetWindowLongPtrW(g_taskbar, GWL_EXSTYLE);
        if ((taskbarExStyle & WS_EX_LAYOUTRTL) != 0)
        {
            // ScreenToClient mirrors X for an RTL parent, while SetWindowPos on
            // this parented WS_POPUP expects the unmirrored client coordinate.
            childPoint.x = screenX - taskbarRect.left;
            childPoint.y = screenY - taskbarRect.top;
        }
        else
        {
            ScreenToClient(g_taskbar, &childPoint);
        }

        SetWindowPos(
            g_display,
            HWND_TOP,
            childPoint.x,
            childPoint.y,
            g_width,
            g_height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    COLORREF TransparentColor()
    {
        return IsLightTheme() ? RGB(243, 243, 243) : RGB(32, 32, 32);
    }

    void PaintDisplay(HWND window)
    {
        PAINTSTRUCT paint = {};
        HDC dc = BeginPaint(window, &paint);
        RECT client = {};
        GetClientRect(window, &client);

        HBRUSH background = CreateSolidBrush(TransparentColor());
        FillRect(dc, &client, background);
        DeleteObject(background);

        const int fontPoints = g_displayMode == DisplayMode::Total ? 10 : 9;
        HFONT font = CreateFontW(
            -MulDiv(fontPoints, static_cast<int>(g_dpi), 72),
            0,
            0,
            0,
            FW_SEMIBOLD,
            FALSE,
            FALSE,
            FALSE,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY,
            DEFAULT_PITCH | FF_DONTCARE,
            L"Segoe UI Semibold");
        HGDIOBJ oldFont = SelectObject(dc, font);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, IsLightTheme() ? RGB(24, 24, 24) : RGB(245, 245, 245));

        if (g_displayMode == DisplayMode::Total)
        {
            RECT totalRect = { Scale(2), 0, g_width - Scale(2), g_height };
            DrawTextW(
                dc,
                g_totalText.c_str(),
                -1,
                &totalRect,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        }
        else
        {
            const int leftPadding = Scale(4);
            RECT topRect = { leftPadding, 0, g_width, g_height / 2 };
            RECT bottomRect = { leftPadding, g_height / 2, g_width, g_height };
            const UINT textFlags = DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX;
            DrawTextW(dc, g_uploadText.c_str(), -1, &topRect, textFlags);
            DrawTextW(dc, g_downloadText.c_str(), -1, &bottomRect, textFlags);
        }

        SelectObject(dc, oldFont);
        DeleteObject(font);
        EndPaint(window, &paint);
    }

    void RenderDisplay()
    {
        if (!IsWindow(g_display))
            return;
        SetLayeredWindowAttributes(g_display, TransparentColor(), 0, LWA_COLORKEY);
        RedrawWindow(g_display, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ERASE);
    }

    int HistoryTableTop(HWND window)
    {
        return ScaleForWindow(window, 116);
    }

    int HistoryHeaderHeight(HWND window)
    {
        return ScaleForWindow(window, 34);
    }

    int HistoryRowHeight(HWND window)
    {
        return ScaleForWindow(window, 32);
    }

    void UpdateHistoryScrollBar(HWND window)
    {
        RECT client = {};
        GetClientRect(window, &client);
        const int rowsTop = HistoryTableTop(window) + HistoryHeaderHeight(window);
        const int rowHeight = HistoryRowHeight(window);
        const int visibleRows = std::max(1, (static_cast<int>(client.bottom) - rowsTop) / rowHeight);

        SCROLLINFO scroll = {};
        scroll.cbSize = sizeof(scroll);
        scroll.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        scroll.nMin = 0;
        scroll.nMax = std::max(0, static_cast<int>(g_history.size()) - 1);
        scroll.nPage = static_cast<UINT>(visibleRows);
        scroll.nPos = g_historyScroll;
        SetScrollInfo(window, SB_VERT, &scroll, TRUE);

        scroll.fMask = SIF_POS;
        GetScrollInfo(window, SB_VERT, &scroll);
        g_historyScroll = scroll.nPos;
    }

    void DrawHistoryCell(HDC dc, const std::wstring& text, RECT rect, bool rtl)
    {
        const int padding = 8;
        rect.left += padding;
        rect.right -= padding;
        DrawTextW(
            dc,
            text.c_str(),
            -1,
            &rect,
            DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | (rtl ? DT_RTLREADING : 0));
    }

    void PaintHistory(HWND window)
    {
        PAINTSTRUCT paint = {};
        HDC dc = BeginPaint(window, &paint);
        RECT client = {};
        GetClientRect(window, &client);

        const bool light = IsLightTheme();
        const COLORREF backgroundColor = light ? RGB(250, 250, 250) : RGB(32, 32, 32);
        const COLORREF textColor = light ? RGB(25, 25, 25) : RGB(245, 245, 245);
        const COLORREF secondaryTextColor = light ? RGB(88, 88, 88) : RGB(190, 190, 190);
        const COLORREF headerColor = light ? RGB(238, 238, 238) : RGB(53, 53, 53);
        const COLORREF alternateColor = light ? RGB(246, 246, 246) : RGB(39, 39, 39);
        const COLORREF lineColor = light ? RGB(220, 220, 220) : RGB(70, 70, 70);

        HBRUSH background = CreateSolidBrush(backgroundColor);
        FillRect(dc, &client, background);
        DeleteObject(background);
        SetBkMode(dc, TRANSPARENT);

        const int margin = ScaleForWindow(window, 22);
        HFONT titleFont = CreateFontW(
            -ScaleForWindow(window, 22), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
            DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        HFONT bodyFont = CreateFontW(
            -ScaleForWindow(window, 14), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
            DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        HFONT headerFont = CreateFontW(
            -ScaleForWindow(window, 14), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
            DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI Semibold");

        HGDIOBJ oldFont = SelectObject(dc, titleFont);
        SetTextColor(dc, textColor);
        RECT titleRect = { margin, ScaleForWindow(window, 14), client.right - margin, ScaleForWindow(window, 50) };
        DrawTextW(dc, L"סטטיסטיקת תעבורה היסטורית", -1, &titleRect,
            DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_RTLREADING | DT_NOPREFIX);

        ULONGLONG totalDownload = 0;
        ULONGLONG totalUpload = 0;
        for (const DayUsage& item : g_history)
        {
            totalDownload += item.downloadBytes;
            totalUpload += item.uploadBytes;
        }

        SelectObject(dc, bodyFont);
        SetTextColor(dc, secondaryTextColor);
        std::wstring summary = L"סה״כ: " + FormatBytes(totalDownload + totalUpload)
            + L"     הורדה: " + FormatBytes(totalDownload)
            + L"     העלאה: " + FormatBytes(totalUpload);
        RECT summaryRect = { margin, ScaleForWindow(window, 54), client.right - margin, ScaleForWindow(window, 91) };
        DrawTextW(dc, summary.c_str(), -1, &summaryRect,
            DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_RTLREADING | DT_NOPREFIX | DT_END_ELLIPSIS);

        const int tableTop = HistoryTableTop(window);
        const int headerHeight = HistoryHeaderHeight(window);
        const int rowHeight = HistoryRowHeight(window);
        const int tableLeft = margin;
        const int tableRight = client.right - margin;
        const int tableWidth = std::max(1, tableRight - tableLeft);
        const int dateWidth = tableWidth * 22 / 100;
        const int valueWidth = (tableWidth - dateWidth) / 3;

        RECT columns[4] = {
            { tableRight - dateWidth, tableTop, tableRight, tableTop + headerHeight },
            { tableRight - dateWidth - valueWidth, tableTop, tableRight - dateWidth, tableTop + headerHeight },
            { tableRight - dateWidth - valueWidth * 2, tableTop, tableRight - dateWidth - valueWidth, tableTop + headerHeight },
            { tableLeft, tableTop, tableRight - dateWidth - valueWidth * 2, tableTop + headerHeight }
        };

        HBRUSH headerBrush = CreateSolidBrush(headerColor);
        RECT headerRect = { tableLeft, tableTop, tableRight, tableTop + headerHeight };
        FillRect(dc, &headerRect, headerBrush);
        DeleteObject(headerBrush);

        SelectObject(dc, headerFont);
        SetTextColor(dc, textColor);
        DrawHistoryCell(dc, L"תאריך", columns[0], true);
        DrawHistoryCell(dc, L"הורדה", columns[1], true);
        DrawHistoryCell(dc, L"העלאה", columns[2], true);
        DrawHistoryCell(dc, L"סה״כ", columns[3], true);

        UpdateHistoryScrollBar(window);
        const int rowsTop = tableTop + headerHeight;
        const int visibleRows = std::max(0, (static_cast<int>(client.bottom) - rowsTop + rowHeight - 1) / rowHeight);
        SelectObject(dc, bodyFont);

        if (g_history.empty())
        {
            SetTextColor(dc, secondaryTextColor);
            RECT emptyRect = { tableLeft, rowsTop, tableRight, client.bottom };
            DrawTextW(dc, L"עדיין אין נתונים — ההיסטוריה מתחילה להצטבר מעכשיו.", -1, &emptyRect,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_RTLREADING | DT_NOPREFIX);
        }
        else
        {
            for (int row = 0; row < visibleRows; ++row)
            {
                const int displayIndex = g_historyScroll + row;
                if (displayIndex >= static_cast<int>(g_history.size()))
                    break;

                const DayUsage& item = g_history[g_history.size() - 1 - displayIndex];
                const int top = rowsTop + row * rowHeight;
                RECT rowRect = { tableLeft, top, tableRight, top + rowHeight };
                if ((displayIndex % 2) != 0)
                {
                    HBRUSH alternateBrush = CreateSolidBrush(alternateColor);
                    FillRect(dc, &rowRect, alternateBrush);
                    DeleteObject(alternateBrush);
                }

                RECT rowColumns[4] = {
                    { columns[0].left, top, columns[0].right, top + rowHeight },
                    { columns[1].left, top, columns[1].right, top + rowHeight },
                    { columns[2].left, top, columns[2].right, top + rowHeight },
                    { columns[3].left, top, columns[3].right, top + rowHeight }
                };
                SetTextColor(dc, textColor);
                DrawHistoryCell(dc, FormatDate(item.date), rowColumns[0], false);
                DrawHistoryCell(dc, FormatBytes(item.downloadBytes), rowColumns[1], false);
                DrawHistoryCell(dc, FormatBytes(item.uploadBytes), rowColumns[2], false);
                DrawHistoryCell(dc, FormatBytes(item.downloadBytes + item.uploadBytes), rowColumns[3], false);

                HPEN linePen = CreatePen(PS_SOLID, 1, lineColor);
                HGDIOBJ oldPen = SelectObject(dc, linePen);
                MoveToEx(dc, tableLeft, top + rowHeight - 1, nullptr);
                LineTo(dc, tableRight, top + rowHeight - 1);
                SelectObject(dc, oldPen);
                DeleteObject(linePen);
            }
        }

        SelectObject(dc, oldFont);
        DeleteObject(titleFont);
        DeleteObject(bodyFont);
        DeleteObject(headerFont);
        EndPaint(window, &paint);
    }

    void ScrollHistory(HWND window, int request, int thumbPosition = 0)
    {
        SCROLLINFO scroll = {};
        scroll.cbSize = sizeof(scroll);
        scroll.fMask = SIF_ALL;
        GetScrollInfo(window, SB_VERT, &scroll);
        int position = scroll.nPos;
        switch (request)
        {
        case SB_LINEUP: position -= 1; break;
        case SB_LINEDOWN: position += 1; break;
        case SB_PAGEUP: position -= static_cast<int>(scroll.nPage); break;
        case SB_PAGEDOWN: position += static_cast<int>(scroll.nPage); break;
        case SB_THUMBPOSITION:
        case SB_THUMBTRACK: position = thumbPosition; break;
        case SB_TOP: position = scroll.nMin; break;
        case SB_BOTTOM: position = scroll.nMax; break;
        default: return;
        }

        scroll.fMask = SIF_POS;
        scroll.nPos = position;
        SetScrollInfo(window, SB_VERT, &scroll, TRUE);
        GetScrollInfo(window, SB_VERT, &scroll);
        if (g_historyScroll != scroll.nPos)
        {
            g_historyScroll = scroll.nPos;
            InvalidateRect(window, nullptr, FALSE);
        }
    }

    LRESULT CALLBACK HistoryWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
    {
        switch (message)
        {
        case WM_PAINT:
            PaintHistory(window);
            return 0;
        case WM_SIZE:
            UpdateHistoryScrollBar(window);
            InvalidateRect(window, nullptr, FALSE);
            return 0;
        case WM_VSCROLL:
        {
            SCROLLINFO scroll = {};
            scroll.cbSize = sizeof(scroll);
            scroll.fMask = SIF_TRACKPOS;
            GetScrollInfo(window, SB_VERT, &scroll);
            ScrollHistory(window, LOWORD(wParam), scroll.nTrackPos);
            return 0;
        }
        case WM_MOUSEWHEEL:
        {
            const int steps = GET_WHEEL_DELTA_WPARAM(wParam) / WHEEL_DELTA;
            const int request = steps > 0 ? SB_LINEUP : SB_LINEDOWN;
            for (int index = 0; index < std::abs(steps) * 3; ++index)
                ScrollHistory(window, request);
            return 0;
        }
        case WM_KEYDOWN:
            if (wParam == VK_UP) ScrollHistory(window, SB_LINEUP);
            else if (wParam == VK_DOWN) ScrollHistory(window, SB_LINEDOWN);
            else if (wParam == VK_PRIOR) ScrollHistory(window, SB_PAGEUP);
            else if (wParam == VK_NEXT) ScrollHistory(window, SB_PAGEDOWN);
            else if (wParam == VK_HOME) ScrollHistory(window, SB_TOP);
            else if (wParam == VK_END) ScrollHistory(window, SB_BOTTOM);
            else break;
            return 0;
        case WM_GETMINMAXINFO:
        {
            MINMAXINFO* info = reinterpret_cast<MINMAXINFO*>(lParam);
            info->ptMinTrackSize.x = ScaleForWindow(window, 520);
            info->ptMinTrackSize.y = ScaleForWindow(window, 330);
            return 0;
        }
        case WM_DPICHANGED:
        {
            RECT* suggested = reinterpret_cast<RECT*>(lParam);
            SetWindowPos(window, nullptr, suggested->left, suggested->top,
                suggested->right - suggested->left, suggested->bottom - suggested->top,
                SWP_NOACTIVATE | SWP_NOZORDER);
            InvalidateRect(window, nullptr, TRUE);
            return 0;
        }
        case WM_SETTINGCHANGE:
        case WM_THEMECHANGED:
            InvalidateRect(window, nullptr, TRUE);
            return 0;
        case WM_NCDESTROY:
            if (window == g_historyWindow)
                g_historyWindow = nullptr;
            break;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }

    void ShowHistoryWindow()
    {
        SaveHistory();
        if (IsWindow(g_historyWindow))
        {
            ShowWindow(g_historyWindow, SW_RESTORE);
            SetForegroundWindow(g_historyWindow);
            InvalidateRect(g_historyWindow, nullptr, FALSE);
            return;
        }

        g_historyScroll = 0;
        g_historyWindow = CreateWindowExW(
            WS_EX_APPWINDOW,
            kHistoryClass,
            L"סטטיסטיקת תעבורה היסטורית",
            WS_OVERLAPPEDWINDOW | WS_VSCROLL,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            720,
            470,
            nullptr,
            nullptr,
            g_instance,
            nullptr);
        if (!g_historyWindow)
            return;

        ShowWindow(g_historyWindow, SW_SHOWNORMAL);
        UpdateWindow(g_historyWindow);
        SetForegroundWindow(g_historyWindow);
    }

    void ResetHistory()
    {
        HWND owner = IsWindow(g_historyWindow) ? g_historyWindow : g_display;
        const int answer = MessageBoxW(
            owner,
            L"כל נתוני ההורדה וההעלאה שנצברו יימחקו. האם להמשיך?",
            L"איפוס הסטטיסטיקה",
            MB_YESNO | MB_DEFBUTTON2 | MB_ICONWARNING | MB_RTLREADING | MB_RIGHT);
        if (answer != IDYES)
            return;

        g_history.clear();
        g_historyScroll = 0;
        g_historyDirty = true;
        g_bytesSinceHistorySave = 0;
        g_secondsSinceHistorySave = 0;
        SaveHistory();

        if (IsWindow(g_historyWindow))
        {
            UpdateHistoryScrollBar(g_historyWindow);
            InvalidateRect(g_historyWindow, nullptr, TRUE);
        }
    }

    void ShowContextMenu(HWND owner)
    {
        HMENU menu = CreatePopupMenu();
        HMENU displayMenu = CreatePopupMenu();
        if (!menu || !displayMenu)
        {
            if (displayMenu)
                DestroyMenu(displayMenu);
            if (menu)
                DestroyMenu(menu);
            return;
        }

        AppendMenuW(displayMenu, MF_STRING, kCommandTotal, L"מהירות כוללת");
        AppendMenuW(displayMenu, MF_STRING, kCommandSeparate, L"העלאה והורדה");
        CheckMenuRadioItem(
            displayMenu,
            kCommandSeparate,
            kCommandTotal,
            g_displayMode == DisplayMode::Total ? kCommandTotal : kCommandSeparate,
            MF_BYCOMMAND);

        AppendMenuW(menu, MF_STRING, kCommandHistory, L"סטטיסטיקת תעבורה היסטורית");
        AppendMenuW(
            menu,
            MF_STRING | (g_history.empty() ? MF_GRAYED : MF_ENABLED),
            kCommandResetHistory,
            L"איפוס הסטטיסטיקה...");
        AppendMenuW(menu, MF_POPUP, reinterpret_cast<UINT_PTR>(displayMenu), L"מצב תצוגה");
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(
            menu,
            MF_STRING | (IsRunAtStartupEnabled() ? MF_CHECKED : MF_UNCHECKED),
            kCommandStartup,
            L"הפעל עם Windows");
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu, MF_STRING, kCommandExit, L"יציאה");

        POINT cursor = {};
        GetCursorPos(&cursor);
        const HWND previousForeground = GetForegroundWindow();
        HWND menuOwner = owner;
        if (IsWindow(g_controller))
        {
            menuOwner = g_controller;
            SetWindowPos(
                menuOwner,
                HWND_TOP,
                -32000,
                -32000,
                1,
                1,
                SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
            DWORD foregroundProcess = 0;
            const DWORD foregroundThread = previousForeground
                ? GetWindowThreadProcessId(previousForeground, &foregroundProcess)
                : 0;
            const DWORD currentThread = GetCurrentThreadId();
            const bool inputAttached = foregroundThread != 0
                && foregroundThread != currentThread
                && AttachThreadInput(currentThread, foregroundThread, TRUE);
            SetForegroundWindow(menuOwner);
            SetActiveWindow(menuOwner);
            if (inputAttached)
                AttachThreadInput(currentThread, foregroundThread, FALSE);
        }
        else
        {
            SetForegroundWindow(menuOwner);
        }
        const UINT command = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTALIGN | TPM_BOTTOMALIGN | TPM_LAYOUTRTL,
            cursor.x,
            cursor.y,
            0,
            menuOwner,
            nullptr);
        DestroyMenu(menu);

        if (command != 0)
            PostMessageW(g_controller, WM_COMMAND, command, 0);
        PostMessageW(menuOwner, WM_NULL, 0, 0);
        if (menuOwner == g_controller)
        {
            ShowWindow(menuOwner, SW_HIDE);
            if (GetForegroundWindow() == menuOwner && IsWindow(previousForeground))
                SetForegroundWindow(previousForeground);
        }
    }

    LRESULT CALLBACK DisplayWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
    {
        switch (message)
        {
        case WM_PAINT:
            PaintDisplay(window);
            return 0;
        case WM_RBUTTONUP:
        case WM_CONTEXTMENU:
            ShowContextMenu(window);
            return 0;
        case WM_ERASEBKGND:
            return 1;
        case WM_NCDESTROY:
            if (window == g_display)
                g_display = nullptr;
            break;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }

    bool CreateOrAttachDisplay()
    {
        HWND currentTaskbar = FindWindowW(L"Shell_TrayWnd", nullptr);
        if (!currentTaskbar)
            return false;

        if (!IsWindow(g_display))
        {
            g_display = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                kDisplayClass,
                L"מהירות רשת",
                WS_POPUP,
                0,
                0,
                1,
                1,
                nullptr,
                nullptr,
                g_instance,
                nullptr);
            if (!g_display)
                return false;
        }

        if (g_taskbar != currentTaskbar)
        {
            SetParent(g_display, currentTaskbar);
            g_taskbar = currentTaskbar;
        }

        SetLayeredWindowAttributes(g_display, TransparentColor(), 0, LWA_COLORKEY);
        PositionDisplay();
        return true;
    }

    LRESULT CALLBACK MouseHookProc(int code, WPARAM wParam, LPARAM lParam)
    {
        if (code == HC_ACTION
            && (wParam == WM_RBUTTONDOWN || wParam == WM_RBUTTONUP)
            && IsWindow(g_display))
        {
            const MSLLHOOKSTRUCT* mouse = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
            RECT displayRect = {};
            if (GetWindowRect(g_display, &displayRect) && PtInRect(&displayRect, mouse->pt))
            {
                if (wParam == WM_RBUTTONUP && IsWindow(g_controller))
                    PostMessageW(g_controller, kShowContextMenuMessage, 0, 0);
                return 1;
            }
        }
        return CallNextHookEx(g_mouseHook, code, wParam, lParam);
    }

    void TimerTick()
    {
        if (!CreateOrAttachDisplay())
            return;

        UpdateNetworkRates();
        ++g_timerTicks;
        if (g_historyDirty)
        {
            ++g_secondsSinceHistorySave;
            const bool enoughTraffic = g_bytesSinceHistorySave >= 100ull * 1024ull;
            if ((g_secondsSinceHistorySave >= 30 && enoughTraffic) || g_secondsSinceHistorySave >= 300)
                SaveHistory();
        }

        if (IsWindow(g_historyWindow) && (g_timerTicks % 5 == 0))
            InvalidateRect(g_historyWindow, nullptr, FALSE);
        PositionDisplay();
        RenderDisplay();
    }

    void SetDisplayMode(DisplayMode mode)
    {
        g_displayMode = mode;
        SaveDisplayMode();
        RenderDisplay();
    }

    LRESULT CALLBACK ControlWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
    {
        switch (message)
        {
        case WM_CREATE:
            SetTimer(window, kTimerId, 1000, nullptr);
            PostMessageW(window, WM_TIMER, kTimerId, 0);
            return 0;
        case WM_TIMER:
            if (wParam == kTimerId)
                TimerTick();
            return 0;
        case kShowContextMenuMessage:
            ShowContextMenu(g_display);
            return 0;
        case WM_COMMAND:
            switch (LOWORD(wParam))
            {
            case kCommandStartup:
                SetRunAtStartup(!IsRunAtStartupEnabled());
                return 0;
            case kCommandExit:
                DestroyWindow(window);
                return 0;
            case kCommandHistory:
                ShowHistoryWindow();
                return 0;
            case kCommandSeparate:
                SetDisplayMode(DisplayMode::Separate);
                return 0;
            case kCommandTotal:
                SetDisplayMode(DisplayMode::Total);
                return 0;
            case kCommandResetHistory:
                ResetHistory();
                return 0;
            }
            break;
        case WM_SETTINGCHANGE:
        case WM_THEMECHANGED:
            RenderDisplay();
            if (IsWindow(g_historyWindow))
                InvalidateRect(g_historyWindow, nullptr, TRUE);
            return 0;
        case WM_DESTROY:
            KillTimer(window, kTimerId);
            SaveHistory();
            if (IsWindow(g_historyWindow))
                DestroyWindow(g_historyWindow);
            if (g_mouseHook)
            {
                UnhookWindowsHookEx(g_mouseHook);
                g_mouseHook = nullptr;
            }
            if (IsWindow(g_display))
                DestroyWindow(g_display);
            PostQuitMessage(0);
            return 0;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }
}

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, wchar_t*, int)
{
    g_mutex = CreateMutexW(nullptr, TRUE, kMutexName);
    if (!g_mutex || GetLastError() == ERROR_ALREADY_EXISTS)
    {
        if (g_mutex)
            CloseHandle(g_mutex);
        return 0;
    }

    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    WSADATA winsock = {};
    WSAStartup(MAKEWORD(2, 2), &winsock);
    g_instance = instance;
    g_displayMode = LoadDisplayMode();
    LoadHistory();

    WNDCLASSW displayClass = {};
    displayClass.lpfnWndProc = DisplayWindowProc;
    displayClass.hInstance = instance;
    displayClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    displayClass.lpszClassName = kDisplayClass;
    if (!RegisterClassW(&displayClass))
        return 1;

    WNDCLASSW historyClass = {};
    historyClass.lpfnWndProc = HistoryWindowProc;
    historyClass.hInstance = instance;
    historyClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    historyClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    historyClass.lpszClassName = kHistoryClass;
    if (!RegisterClassW(&historyClass))
        return 1;

    WNDCLASSW controlClass = {};
    controlClass.lpfnWndProc = ControlWindowProc;
    controlClass.hInstance = instance;
    controlClass.lpszClassName = kControlClass;
    if (!RegisterClassW(&controlClass))
        return 1;

    g_controller = CreateWindowExW(
        WS_EX_TOOLWINDOW,
        kControlClass,
        L"Taskbar Network Speed Controller",
        WS_POPUP,
        -32000,
        -32000,
        1,
        1,
        nullptr,
        nullptr,
        instance,
        nullptr);
    if (!g_controller)
        return 1;

    g_mouseHook = SetWindowsHookExW(WH_MOUSE_LL, MouseHookProc, instance, 0);

    MSG message = {};
    while (GetMessageW(&message, nullptr, 0, 0) > 0)
    {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    WSACleanup();
    CloseHandle(g_mutex);
    return static_cast<int>(message.wParam);
}

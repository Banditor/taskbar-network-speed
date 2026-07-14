@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%
rc /nologo TaskbarNetworkSpeed.rc
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /MT /EHsc /utf-8 TaskbarNetworkSpeed.cpp TaskbarNetworkSpeed.res /link /SUBSYSTEM:WINDOWS /OUT:TaskbarNetworkSpeed.exe
exit /b %errorlevel%

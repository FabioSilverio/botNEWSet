Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\fasil\Downloads\news-aggregator"
WshShell.Run "cmd /c node runner.js >> .runner.log 2>&1", 0, False

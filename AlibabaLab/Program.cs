using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Http.Features;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:" + (Environment.GetEnvironmentVariable("ALIBABA_LAB_PORT") ?? "5192"));
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 251 * 1024 * 1024);
builder.Services.Configure<FormOptions>(options => options.MultipartBodyLengthLimit = 250 * 1024 * 1024);
var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();

var settings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
var envPath = Environment.GetEnvironmentVariable("ALIBABA_ENV_FILE");
var candidates = new[] { envPath, Path.Combine(app.Environment.ContentRootPath, ".env"),
    Path.Combine(app.Environment.ContentRootPath, "..", ".env"), @"I:\Repos\alibaba\.env" };
var filePath = candidates.FirstOrDefault(File.Exists);
if (filePath is not null)
{
    foreach (var line in File.ReadLines(filePath))
    {
        var parts = line.Split('=', 2);
        if (parts.Length == 2 && !parts[0].TrimStart().StartsWith('#'))
            settings[parts[0].Trim()] = parts[1].Trim().Trim('"', '\'');
    }
}
string? Setting(string name) => Environment.GetEnvironmentVariable(name) ?? settings.GetValueOrDefault(name);
var key = Setting("DASHSCOPE_API_KEY") ?? Setting("API-KEY") ?? Setting("API_KEY");
var baseUrl = Setting("DASHSCOPE_BASE_URL") ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
using var upstream = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
{
    BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"),
    Timeout = TimeSpan.FromSeconds(30)
};

app.MapGet("/api/models", async (CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(key))
        return Results.BadRequest(new { error = "Ключ отсутствует. Проверьте .env." });
    using var request = Request(HttpMethod.Get, "models");
    try
    {
        using var reply = await upstream.SendAsync(request, ct);
        return Results.Text(await reply.Content.ReadAsStringAsync(ct), "application/json", statusCode: (int)reply.StatusCode);
    }
    catch (HttpRequestException) { return Results.Problem("Не удалось подключиться к Alibaba.", statusCode: 502); }
    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
    { return Results.Problem("Истекло время ожидания Alibaba.", statusCode: 504); }
});

app.MapPost("/api/chat", async (ChatInput input, HttpContext context) =>
{
    var ct = context.RequestAborted;
    if (string.IsNullOrWhiteSpace(key))
    {
        await Results.BadRequest(new { error = "Ключ отсутствует. Проверьте .env." }).ExecuteAsync(context);
        return;
    }

    if (string.IsNullOrWhiteSpace(input.Model) || input.Messages is not { Length: > 0 and <= 100 } ||
        input.Messages.Any(m => m is null || m.Content is null || m.Content.Length > 20000 ||
            m.Role is not ("user" or "assistant")))
    {
        await Results.BadRequest(new { error = "Некорректная модель или история сообщений." }).ExecuteAsync(context);
        return;
    }

    using var request = Request(HttpMethod.Post, "chat/completions");
    var body = new Dictionary<string, object>
    {
        ["model"] = input.Model, ["messages"] = input.Messages, ["stream"] = true,
        ["max_tokens"] = input.Benchmark ? 32 : 1024
    };
    if (input.DisableThinking) body["enable_thinking"] = false;
    request.Content = JsonContent.Create(body);
    try
    {
        using var reply = await upstream.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var response = context.Response;
        response.StatusCode = (int)reply.StatusCode;
        response.ContentType = reply.Content.Headers.ContentType?.ToString() ?? "application/octet-stream";
        if (!reply.IsSuccessStatusCode)
        {
            await response.WriteAsync(await reply.Content.ReadAsStringAsync(ct), ct);
            return;
        }

        context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        response.Headers.CacheControl = "no-store";
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromMinutes(3));
        await using var stream = await reply.Content.ReadAsStreamAsync(deadline.Token);
        var buffer = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(buffer, deadline.Token)) != 0)
        {
            await response.Body.WriteAsync(buffer.AsMemory(0, count), deadline.Token);
            await response.Body.FlushAsync(deadline.Token);
        }
    }
    catch (HttpRequestException) when (!context.Response.HasStarted)
    { await Results.Problem("Не удалось подключиться к Alibaba.", statusCode: 502).ExecuteAsync(context); }
    catch (OperationCanceledException) when (!ct.IsCancellationRequested && !context.Response.HasStarted)
    { await Results.Problem("Истекло время ожидания Alibaba.", statusCode: 504).ExecuteAsync(context); }
});

app.MapPost("/api/audio", async (HttpRequest request, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "Ожидается один файл." });
    var files = (await request.ReadFormAsync(ct)).Files;
    if (files.Count != 1 || files[0].Length == 0)
        return Results.BadRequest(new { error = "Выберите один непустой файл." });

    var directory = Directory.CreateTempSubdirectory("alibaba-audio-");
    try
    {
        var input = Path.Combine(directory.FullName, "input");
        var output = Path.Combine(directory.FullName, "audio.wav");
        await using (var stream = File.Create(input))
            await files[0].CopyToAsync(stream, ct);

        var start = new ProcessStartInfo("ffmpeg") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true };
        foreach (var arg in new[] { "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", input,
            "-map", "0:a:0", "-vn", "-t", "1801", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", output })
            start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var errors = process.StandardError.ReadToEndAsync();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromMinutes(2));
        try { await process.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            if (ct.IsCancellationRequested) throw;
            return Results.Problem("Истекло время обработки файла.", statusCode: 504);
        }
        await errors;
        if (process.ExitCode != 0 || !File.Exists(output))
            return Results.BadRequest(new { error = "FFmpeg не смог извлечь аудиодорожку." });
        if (new FileInfo(output).Length > 1800L * 48000 + 4096)
            return Results.BadRequest(new { error = "Максимальная длительность записи — 30 минут." });
        return Results.File(await File.ReadAllBytesAsync(output, ct), "audio/wav");
    }
    catch (System.ComponentModel.Win32Exception)
    { return Results.Problem("FFmpeg должен быть доступен в PATH."); }
    finally { directory.Delete(recursive: true); }
});

HttpRequestMessage Request(HttpMethod method, string path)
{
    var request = new HttpRequestMessage(method, path);
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
    return request;
}

app.Run();
record ChatInput(string Model, Message[] Messages, bool DisableThinking, bool Benchmark);
record Message(string Role, string Content);
